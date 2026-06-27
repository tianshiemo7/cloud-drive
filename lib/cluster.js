// ==================== 集群通信模块 ====================
// HMAC-SHA256 请求签名 / 验证 / 对等请求 / 文件聚合 / 代理流

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { loadKeys, loadFolders } = require('./persistence');
const { safePath, isPreviewable } = require('./utils');

// ==================== 工具 ====================

function isEnabled() {
  return config.clusterEnabled;
}

// ==================== HMAC 签名 ====================

function signRequest(method, pathStr, peerSecret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = [method.toUpperCase(), pathStr, timestamp, nonce].join('\n');
  // 优先使用对等节点的专属 secret，回退到全局共享密钥
  const secret = peerSecret || config.clusterSecret;
  const signature = crypto.createHmac('sha256', secret)
    .update(payload)
    .digest('base64');

  return {
    'X-Cluster-NodeId': config.clusterNodeId,
    'X-Cluster-Timestamp': timestamp,
    'X-Cluster-Nonce': nonce,
    'X-Cluster-Signature': signature
  };
}

function getPeerSecret(nodeId) {
  const peer = config.clusterPeers.find(p => p.nodeId === nodeId);
  return peer ? peer.secret : null;
}

function getPeerEndpoint(nodeId) {
  const peer = config.clusterPeers.find(p => p.nodeId === nodeId);
  return peer ? peer.endpoint : null;
}

// ==================== 签名验证中间件 ====================

function verifySignature(req, res, next) {
  const nodeId = req.headers['x-cluster-nodeid'];
  const timestamp = req.headers['x-cluster-timestamp'];
  const nonce = req.headers['x-cluster-nonce'];
  const signature = req.headers['x-cluster-signature'];

  if (!nodeId || !timestamp || !nonce || !signature) {
    return res.status(401).json({ error: '缺少集群认证头' });
  }

  // 时间窗口验证（防重放）
  const now = Math.floor(Date.now() / 1000);
  const reqTime = parseInt(timestamp, 10);
  if (Math.abs(now - reqTime) > config.clusterSignatureWindow) {
    return res.status(401).json({ error: '请求时间戳超出窗口，请检查时钟同步' });
  }

  // 验证签名：先查对等节点列表中的 secret，未找到则回退到全局共享密钥
  let secret = getPeerSecret(nodeId);
  if (!secret) {
    // 信任任何持有相同全局共享密钥的节点（支持一键连接）
    secret = config.clusterSecret;
  }

  if (!secret) {
    return res.status(401).json({ error: `未知节点: ${nodeId}，且未配置共享密钥` });
  }

  // 重构签名
  const pathStr = req.originalUrl; // 包含 /api/internal/...
  const payload = [req.method.toUpperCase(), pathStr, timestamp, nonce].join('\n');
  const expected = crypto.createHmac('sha256', secret)
    .update(payload)
    .digest('base64');

  // 常量时间比较
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ error: '签名验证失败' });
    }
  } catch (e) {
    return res.status(401).json({ error: '签名格式错误' });
  }

  // 验证通过
  req._peerNodeId = nodeId;
  next();
}

// ==================== HTTP 客户端 ====================

function makeRequest(peerUrl, method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, peerUrl);
    // 查找该 endpoint 对应的 peer secret
    const peer = config.clusterPeers.find(p => {
      try { return new URL(p.endpoint).origin === url.origin; } catch (e) { return false; }
    });
    const peerSecret = peer ? peer.secret : null;
    const headers = signRequest(method, url.pathname + url.search, peerSecret);
    headers['Content-Type'] = 'application/json';

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
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
            resolve({ status: res.statusCode, headers: res.headers, data: json });
          }
        } catch (e) {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            reject(new Error('响应解析失败'));
          }
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ==================== 跨节点密钥查找 ====================

async function lookupKeyAcrossPeers(key) {
  const promises = config.clusterPeers.map(async (peer) => {
    try {
      const result = await makeRequest(peer.endpoint, 'POST', '/api/internal/lookup-key', { key });
      if (result.data && result.data.found) {
        return { found: true, filename: result.data.filename, nodeId: peer.nodeId };
      }
      return null;
    } catch (e) {
      return null; // 节点不可达
    }
  });

  const results = await Promise.all(promises);
  return results.find(r => r && r.found) || null;
}

// ==================== 文件聚合 ====================

function getLocalFileList() {
  const keys = loadKeys();
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

  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return files;
}

async function getAggregatedFiles() {
  const localFiles = getLocalFileList();
  const nodes = [{ nodeId: config.clusterNodeId, fileCount: localFiles.length, error: null }];

  // 并行请求所有对等节点
  const remotePromises = config.clusterPeers.map(async (peer) => {
    try {
      const result = await makeRequest(peer.endpoint, 'GET', '/api/internal/files');
      nodes.push({ nodeId: peer.nodeId, fileCount: result.data.files ? result.data.files.length : 0, error: null });
      // 为远程文件添加 nodeId
      return (result.data.files || []).map(f => ({ ...f, nodeId: peer.nodeId }));
    } catch (e) {
      nodes.push({ nodeId: peer.nodeId, fileCount: 0, error: e.message || 'unreachable' });
      return [];
    }
  });

  const remoteResults = await Promise.all(remotePromises);
  const allFiles = [...localFiles, ...remoteResults.flat()];

  return { files: allFiles, nodes };
}

// ==================== 代理下载/预览 ====================

function proxyDownload(sourceNodeId, filename, res) {
  const endpoint = getPeerEndpoint(sourceNodeId);
  if (!endpoint) {
    return res.status(502).json({ error: `未知节点: ${sourceNodeId}` });
  }

  const url = new URL(`/api/internal/file/${encodeURIComponent(filename)}/download`, endpoint);
  const peerSecret = getPeerSecret(sourceNodeId);
  const headers = signRequest('GET', url.pathname, peerSecret);

  const client = url.protocol === 'https:' ? https : http;
  const req = client.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'GET',
    headers,
    timeout: config.clusterTimeout
  }, (peerRes) => {
    if (peerRes.statusCode >= 400) {
      const chunks = [];
      peerRes.on('data', d => chunks.push(d));
      peerRes.on('end', () => {
        try {
          const err = JSON.parse(Buffer.concat(chunks).toString());
          res.status(peerRes.statusCode).json(err);
        } catch (e) {
          res.status(502).json({ error: `远程节点返回错误: HTTP ${peerRes.statusCode}` });
        }
      });
      return;
    }

    // 转发响应头和流
    res.status(peerRes.statusCode);
    if (peerRes.headers['content-type']) res.set('Content-Type', peerRes.headers['content-type']);
    if (peerRes.headers['content-length']) res.set('Content-Length', peerRes.headers['content-length']);
    if (peerRes.headers['content-disposition']) res.set('Content-Disposition', peerRes.headers['content-disposition']);

    peerRes.pipe(res);
  });

  req.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `文件所在节点 ${sourceNodeId} 不可达，请稍后重试` });
    }
  });
  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(502).json({ error: `文件所在节点 ${sourceNodeId} 请求超时` });
    }
  });
  req.end();
}

function proxyPreview(sourceNodeId, filename, res) {
  const endpoint = getPeerEndpoint(sourceNodeId);
  if (!endpoint) {
    return res.status(502).json({ error: `未知节点: ${sourceNodeId}` });
  }

  const url = new URL(`/api/internal/file/${encodeURIComponent(filename)}/preview`, endpoint);
  const peerSecret = getPeerSecret(sourceNodeId);
  const headers = signRequest('GET', url.pathname, peerSecret);

  const client = url.protocol === 'https:' ? https : http;
  const req = client.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'GET',
    headers,
    timeout: config.clusterTimeout
  }, (peerRes) => {
    if (peerRes.statusCode >= 400) {
      const chunks = [];
      peerRes.on('data', d => chunks.push(d));
      peerRes.on('end', () => {
        try {
          const err = JSON.parse(Buffer.concat(chunks).toString());
          res.status(peerRes.statusCode).json(err);
        } catch (e) {
          res.status(502).json({ error: `远程节点返回错误: HTTP ${peerRes.statusCode}` });
        }
      });
      return;
    }

    res.status(peerRes.statusCode);
    if (peerRes.headers['content-type']) res.set('Content-Type', peerRes.headers['content-type']);
    if (peerRes.headers['content-length']) res.set('Content-Length', peerRes.headers['content-length']);

    peerRes.pipe(res);
  });

  req.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `文件所在节点 ${sourceNodeId} 不可达，请稍后重试` });
    }
  });
  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(502).json({ error: `文件所在节点 ${sourceNodeId} 请求超时` });
    }
  });
  req.end();
}

// ==================== 内部 API 路由 ====================

function createInternalRouter() {
  const router = express.Router();
  router.use(verifySignature);

  // 健康检查
  router.get('/ping', (req, res) => {
    const keys = loadKeys();
    res.json({
      nodeId: config.clusterNodeId,
      nodeName: config.clusterNodeName,
      status: 'ok',
      fileCount: Object.keys(keys).length,
      uptime: process.uptime(),
      version: '2.2.0'
    });
  });

  // 返回本节点对等列表（供拓扑发现，不含 secret）
  router.get('/peers', (req, res) => {
    res.json({
      nodeId: config.clusterNodeId,
      peers: config.clusterPeers.map(p => ({ nodeId: p.nodeId, endpoint: p.endpoint }))
    });
  });

  // 列出本节点文件
  router.get('/files', (req, res) => {
    const files = getLocalFileList();
    // 不向对等节点暴露文件密钥
    const safeFiles = files.map(({ key, ...rest }) => rest);
    res.json({
      nodeId: config.clusterNodeId,
      files: safeFiles
    });
  });

  // 按密钥查找文件
  router.post('/lookup-key', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ found: false, error: '缺少密钥' });

    const keys = loadKeys();
    for (const [filename, meta] of Object.entries(keys)) {
      const m = typeof meta === 'string' ? { key: meta } : meta;
      if (m.key === key) {
        // 检查过期
        if (m.expiresAt && Date.now() > new Date(m.expiresAt).getTime()) {
          return res.json({ found: false, error: '密钥已过期' });
        }
        if (m.maxDownloads && m.downloadCount >= m.maxDownloads) {
          return res.json({ found: false, error: '下载次数已用完' });
        }
        return res.json({ found: true, filename, nodeId: config.clusterNodeId });
      }
    }

    res.json({ found: false });
  });

  // 流式传输文件（下载）
  router.get('/file/:filename/download', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = safePath(config.UPLOAD_DIR, filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.download(filePath, filename);
  });

  // 流式传输文件（预览）
  router.get('/file/:filename/preview', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = safePath(config.UPLOAD_DIR, filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(filePath);
  });

  // 磁盘信息
  router.get('/disk', (req, res) => {
    let totalSize = 0, fileCount = 0;
    try {
      fs.readdirSync(config.UPLOAD_DIR).forEach(name => {
        try { totalSize += fs.statSync(path.join(config.UPLOAD_DIR, name)).size; fileCount++; } catch (e) { /* skip */ }
      });
    } catch (e) { /* ignore */ }
    res.json({
      nodeId: config.clusterNodeId,
      usedBytes: totalSize,
      fileCount
    });
  });

  // 文件夹列表（内部）
  router.get('/folders', (req, res) => {
    const folders = loadFolders();
    const nodeFolders = [];
    for (const [id, f] of Object.entries(folders)) {
      if (f.nodeId === config.clusterNodeId) {
        nodeFolders.push({ id, name: f.name, parent: f.parent, nodeId: f.nodeId, createdAt: f.createdAt });
      }
    }
    res.json({ nodeId: config.clusterNodeId, folders: nodeFolders });
  });

  return router;
}

// ==================== 文件夹聚合 ====================

async function getAggregatedFolders() {
  const localFolders = loadFolders();
  const folders = [];
  for (const [id, f] of Object.entries(localFolders)) {
    folders.push({ id, name: f.name, parent: f.parent, nodeId: f.nodeId || config.clusterNodeId, createdAt: f.createdAt });
  }

  const grouped = {};
  grouped[config.clusterNodeId] = folders.filter(f => f.nodeId === config.clusterNodeId);

  // 聚合远程
  for (const peer of config.clusterPeers) {
    try {
      const result = await makeRequest(peer.endpoint, 'GET', '/api/internal/folders');
      if (result.data && result.data.folders) {
        grouped[peer.nodeId] = result.data.folders;
      }
    } catch (e) {
      grouped[peer.nodeId] = [];
    }
  }

  return { folders, grouped };
}

// ==================== 对等节点状态检查 ====================

async function checkAllPeers() {
  const results = [];
  for (const peer of config.clusterPeers) {
    try {
      const result = await makeRequest(peer.endpoint, 'GET', '/api/internal/ping');
      results.push({
        nodeId: peer.nodeId,
        endpoint: peer.endpoint,
        online: true,
        nodeName: result.data?.nodeName || peer.nodeId,
        fileCount: result.data?.fileCount || 0,
        version: result.data?.version || '?'
      });
    } catch (e) {
      results.push({
        nodeId: peer.nodeId,
        endpoint: peer.endpoint,
        online: false,
        error: e.message
      });
    }
  }
  return results;
}

// ==================== 拓扑发现 ====================

async function discoverTopology(entryEndpoint, entrySecret) {
  const visited = new Set([config.clusterNodeId]);
  // 添加已有对等节点
  for (const p of config.clusterPeers) visited.add(p.nodeId);

  const discovered = [];
  const queue = [{ endpoint: entryEndpoint, secret: entrySecret, nodeId: null }];

  while (queue.length > 0) {
    const current = queue.shift();

    // 先 ping 获取 nodeId
    let nodeId = current.nodeId;
    if (!nodeId) {
      try {
        // 临时签名（用提供的 secret）
        const tempConfig = { ...config, clusterSecret: current.secret, clusterNodeId: 'temp-discover' };
        // 使用自己的 makeRequest，但临时替换 secret
        const origSecret = config.clusterSecret;
        // 直接用 HTTP 请求（简化版，不需要完整验证）
        const result = await makeSimpleRequest(current.endpoint, '/api/internal/ping', current.secret);
        if (result && result.nodeId) {
          nodeId = result.nodeId;
        } else {
          continue; // 跳过不可达节点
        }
      } catch (e) {
        continue;
      }
    }

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    discovered.push({
      nodeId: nodeId,
      endpoint: current.endpoint,
      secret: current.secret
    });

    // 获取该节点的对等列表
    try {
      const result = await makeSimpleRequest(current.endpoint, '/api/internal/peers', current.secret);
      if (result && result.peers) {
        for (const p of result.peers) {
          if (!visited.has(p.nodeId)) {
            queue.push({ endpoint: p.endpoint, secret: current.secret, nodeId: p.nodeId });
          }
        }
      }
    } catch (e) { /* 跳过 */ }
  }

  return discovered;
}

// 简化的 HTTP 请求（用于拓扑发现，不需要完整 config）
function makeSimpleRequest(endpoint, pathStr, secret) {
  const http = require('http');
  const https = require('https');
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, endpoint);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const payload = ['GET', url.pathname, timestamp, nonce].join('\n');
    const signature = require('crypto').createHmac('sha256', secret).update(payload).digest('base64');

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET',
      headers: {
        'X-Cluster-NodeId': 'topology-discover',
        'X-Cluster-Timestamp': timestamp,
        'X-Cluster-Nonce': nonce,
        'X-Cluster-Signature': signature
      },
      timeout: 5000
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = {
  isEnabled,
  signRequest,
  verifySignature,
  getPeerSecret,
  getPeerEndpoint,
  makeRequest,
  lookupKeyAcrossPeers,
  getLocalFileList,
  getAggregatedFiles,
  getAggregatedFolders,
  checkAllPeers,
  discoverTopology,
  proxyDownload,
  proxyPreview,
  createInternalRouter
};
