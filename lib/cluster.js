// ==================== 集群通信模块 v3.0 ====================
// 极简设计：共享密钥认证 + clone 接口 + 定期同步 + 本地缓存
// 不再使用 HMAC 签名，不再实时聚合对等节点

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { loadKeys, loadFolders, loadPeerCache, savePeerCache } = require('./persistence');
const { safePath, isPreviewable } = require('./utils');

// ==================== 共享密钥验证中间件 ====================

function verifySecret(req, res, next) {
  const secret = req.headers['x-cluster-secret'];
  if (!secret || secret !== config.clusterSecret) {
    return res.status(401).json({ error: '集群密钥无效' });
  }
  next();
}

// ==================== Clone 索引生成 ====================

function cloneIndex() {
  const keys = loadKeys();
  const folders = loadFolders();
  const files = [];

  try {
    const names = fs.readdirSync(config.UPLOAD_DIR).filter(n => !n.startsWith('.'));
    for (const name of names) {
      const fp = path.join(config.UPLOAD_DIR, name);
      try {
        const stats = fs.statSync(fp);
        const meta = keys[name];
        const m = typeof meta === 'string' ? { key: meta } : (meta || {});
        files.push({
          name,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          key: m.key || null,
          expiresAt: m.expiresAt || null,
          oneTime: !!m.oneTime,
          downloadCount: m.downloadCount || 0,
          maxDownloads: m.maxDownloads || null,
          md5: m.md5 || null,
          preview: isPreviewable(name),
          folder: m.folder || null,
          nodeId: config.clusterNodeId
        });
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* ignore */ }

  // 仅输出本节点文件夹
  const nodeFolders = {};
  for (const [id, f] of Object.entries(folders)) {
    if (f.nodeId === config.clusterNodeId) {
      nodeFolders[id] = f;
    }
  }

  return {
    nodeId: config.clusterNodeId,
    nodeName: config.clusterNodeName,
    version: '3.0',
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    folderCount: Object.keys(nodeFolders).length,
    files,
    folders: nodeFolders
  };
}

// ==================== HTTP fetch 辅助 ====================

function fetchFromPeer(peer, pathStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, peer.endpoint);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'X-Cluster-Secret': peer.secret || config.clusterSecret
      },
      timeout: config.clusterTimeout
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        try {
          const json = JSON.parse(data.toString());
          if (res.statusCode >= 400) {
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('响应解析失败'));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ==================== 定期同步 ====================

let _syncTimer = null;
let _lastSyncTime = null;

async function syncFromPeers() {
  if (!config.clusterEnabled || config.clusterPeers.length === 0) return;

  const cache = loadPeerCache();
  let changed = false;

  for (const peer of config.clusterPeers) {
    try {
      const index = await fetchFromPeer(peer, '/api/internal/clone');
      const prev = cache[peer.nodeId];
      // 检查是否有变化
      if (!prev || prev.fileCount !== index.fileCount ||
          prev.generatedAt !== index.generatedAt) {
        cache[peer.nodeId] = {
          ...index,
          cachedAt: new Date().toISOString(),
          online: true,
          error: null
        };
        changed = true;
      } else if (prev) {
        // 无变化，仅更新在线状态和心跳时间
        cache[peer.nodeId].online = true;
        cache[peer.nodeId].error = null;
      }
    } catch (e) {
      if (cache[peer.nodeId]) {
        cache[peer.nodeId].online = false;
        cache[peer.nodeId].error = e.message;
      } else {
        cache[peer.nodeId] = {
          nodeId: peer.nodeId,
          online: false,
          error: e.message,
          cachedAt: new Date().toISOString(),
          files: [],
          folders: {}
        };
      }
      changed = true;
    }
  }

  if (changed) {
    savePeerCache(cache);
    console.log(`🔄 集群同步完成 (${new Date().toLocaleTimeString()})`);
  }

  // v3.0: 同步更新 cluster-nodes.json 中的节点状态
  try {
    const clusterConfig = require('./cluster-config');
    for (const [nodeId, cached] of Object.entries(cache)) {
      clusterConfig.updatePeerStatus(nodeId, {
        lastSeen: cached.cachedAt || new Date().toISOString(),
        online: !!cached.online,
        fileCount: cached.fileCount || 0,
        error: cached.error || null
      });
    }
  } catch (e) { /* ignore */ }

  _lastSyncTime = new Date().toISOString();
}

function startSyncLoop(intervalMs) {
  if (_syncTimer) clearInterval(_syncTimer);
  const interval = intervalMs || config.syncIntervalMs || 60000;

  // 启动时立即同步一次
  syncFromPeers().catch(e => console.error('首次同步失败:', e.message));

  _syncTimer = setInterval(() => {
    syncFromPeers().catch(e => console.error('定期同步失败:', e.message));
  }, interval);

  console.log(`🔄 集群同步已启动 · 间隔 ${Math.round(interval / 1000)}s`);
}

function stopSyncLoop() {
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
}

function getLastSyncTime() {
  return _lastSyncTime;
}

// ==================== 读取缓存索引 ====================

function getCachedIndex() {
  const localFiles = [];
  try {
    const keys = loadKeys();
    const names = fs.readdirSync(config.UPLOAD_DIR).filter(n => !n.startsWith('.'));
    for (const name of names) {
      const fp = path.join(config.UPLOAD_DIR, name);
      try {
        const stats = fs.statSync(fp);
        const meta = keys[name];
        const m = typeof meta === 'string' ? { key: meta } : (meta || {});
        localFiles.push({
          name, size: stats.size, modified: stats.mtime.toISOString(),
          key: m.key || null, expiresAt: m.expiresAt || null,
          oneTime: !!m.oneTime, downloadCount: m.downloadCount || 0,
          maxDownloads: m.maxDownloads || null, md5: m.md5 || null,
          preview: isPreviewable(name), folder: m.folder || null,
          nodeId: config.clusterNodeId
        });
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* ignore */ }
  localFiles.sort((a, b) => b.modified.localeCompare(a.modified));

  const nodes = [{
    nodeId: config.clusterNodeId,
    nodeName: config.clusterNodeName,
    fileCount: localFiles.length,
    online: true,
    error: null
  }];

  // 合并缓存的对等节点文件
  const allFiles = [...localFiles];
  const peerCache = loadPeerCache();

  for (const [nodeId, cached] of Object.entries(peerCache)) {
    nodes.push({
      nodeId,
      nodeName: cached.nodeName || nodeId,
      fileCount: cached.files ? cached.files.length : 0,
      online: !!cached.online,
      error: cached.error || null,
      cachedAt: cached.cachedAt || null
    });
    if (cached.files && cached.online) {
      for (const f of cached.files) {
        allFiles.push({ ...f, nodeId: f.nodeId || nodeId });
      }
    }
  }

  return { files: allFiles, nodes, lastSync: _lastSyncTime };
}

// ==================== 缓存文件夹索引 ====================

function getCachedFolders() {
  const localFolders = loadFolders();
  const folders = [];
  for (const [id, f] of Object.entries(localFolders)) {
    folders.push({
      id, name: f.name, parent: f.parent,
      nodeId: f.nodeId || config.clusterNodeId, createdAt: f.createdAt
    });
  }

  const grouped = {};
  grouped[config.clusterNodeId] = folders.filter(f => f.nodeId === config.clusterNodeId);

  const peerCache = loadPeerCache();
  for (const [nodeId, cached] of Object.entries(peerCache)) {
    if (cached.folders && cached.online) {
      const peerFolders = [];
      for (const [id, f] of Object.entries(cached.folders)) {
        peerFolders.push({ id, ...f });
      }
      grouped[nodeId] = peerFolders;
    } else {
      grouped[nodeId] = [];
    }
  }

  return { folders, grouped };
}

// ==================== 代理下载/预览 ====================

function proxyFile(sourceNodeId, filename, res, isDownload) {
  const peer = config.clusterPeers.find(p => p.nodeId === sourceNodeId);
  if (!peer) {
    return res.status(502).json({ error: `未知节点: ${sourceNodeId}` });
  }

  const encodedName = encodeURIComponent(filename);
  const url = new URL(`/api/internal/file/${encodedName}`, peer.endpoint);
  const client = url.protocol === 'https:' ? https : http;

  const req = client.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'GET',
    headers: {
      'X-Cluster-Secret': peer.secret || config.clusterSecret
    },
    timeout: config.clusterTimeout
  }, (peerRes) => {
    if (peerRes.statusCode >= 400) {
      const chunks = [];
      peerRes.on('data', d => chunks.push(d));
      peerRes.on('end', () => {
        try {
          res.status(peerRes.statusCode).json(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          res.status(502).json({ error: `远程节点返回错误: HTTP ${peerRes.statusCode}` });
        }
      });
      return;
    }

    res.status(peerRes.statusCode);
    if (peerRes.headers['content-type']) res.set('Content-Type', peerRes.headers['content-type']);
    if (peerRes.headers['content-length']) res.set('Content-Length', peerRes.headers['content-length']);
    if (peerRes.headers['content-disposition']) res.set('Content-Disposition', peerRes.headers['content-disposition']);

    peerRes.pipe(res);
  });

  req.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ error: `节点 ${sourceNodeId} 不可达` });
    }
  });
  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(502).json({ error: `节点 ${sourceNodeId} 请求超时` });
    }
  });
  req.end();
}

function proxyDownload(sourceNodeId, filename, res) {
  proxyFile(sourceNodeId, filename, res, true);
}

function proxyPreview(sourceNodeId, filename, res) {
  proxyFile(sourceNodeId, filename, res, false);
}

// ==================== 对等节点状态检查 ====================

async function checkAllPeers() {
  const results = [];
  const cache = loadPeerCache();
  for (const peer of config.clusterPeers) {
    const cached = cache[peer.nodeId];
    try {
      await fetchFromPeer(peer, '/api/internal/clone');
      results.push({
        nodeId: peer.nodeId,
        endpoint: peer.endpoint,
        online: true,
        nodeName: cached?.nodeName || peer.nodeId,
        fileCount: cached?.fileCount || 0,
        cachedAt: cached?.cachedAt || null,
        lastSync: _lastSyncTime
      });
    } catch (e) {
      results.push({
        nodeId: peer.nodeId,
        endpoint: peer.endpoint,
        online: false,
        nodeName: cached?.nodeName || peer.nodeId,
        fileCount: cached?.fileCount || 0,
        error: e.message,
        lastSync: _lastSyncTime
      });
    }
  }
  return results;
}

// ==================== 内部 API 路由 ====================

function createInternalRouter() {
  const router = express.Router();
  router.use(verifySecret);
  const clusterConfig = require('./cluster-config');

  // v3.0 核心接口：输出本节点完整文件索引（仅元数据，不含文件内容）
  router.get('/clone', (req, res) => {
    res.json(cloneIndex());
  });

  // 🔄 v3.0 双向连接：远程节点宣告自己，本节点自动添加对方为对等节点
  router.post('/announce', (req, res) => {
    const { nodeId, nodeName, endpoint } = req.body;
    if (!nodeId || !endpoint) {
      return res.status(400).json({ error: '缺少 nodeId 或 endpoint' });
    }
    const accepted = clusterConfig.acceptAnnounce({ nodeId, nodeName, endpoint });
    if (accepted) {
      console.log(`🔗 已接受远程宣告: ${nodeId} (${endpoint})`);
      // 立即同步一次
      syncFromPeers().catch(() => {});
    }
    res.json({
      success: true,
      accepted,
      message: accepted
        ? `已添加 ${nodeId} 为对等节点`
        : `${nodeId} 已存在或为自身`
    });
  });

  // 代理下载文件流（需共享密钥）
  router.get('/file/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = safePath(config.UPLOAD_DIR, filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.download(filePath, filename);
  });

  return router;
}

// ==================== 导出 ====================

module.exports = {
  cloneIndex,
  syncFromPeers,
  startSyncLoop,
  stopSyncLoop,
  getLastSyncTime,
  getCachedIndex,
  getCachedFolders,
  proxyDownload,
  proxyPreview,
  checkAllPeers,
  createInternalRouter
};
