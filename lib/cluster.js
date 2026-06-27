// ==================== 集群通信模块 ====================
// HMAC-SHA256 请求签名 / 验证 / 对等请求 / 文件聚合 / 代理流

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { loadKeys } = require('./persistence');
const { safePath, isPreviewable } = require('./utils');

// ==================== 工具 ====================

function isEnabled() {
  return config.clusterEnabled;
}

// ==================== HMAC 签名 ====================

function signRequest(method, pathStr) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = [method.toUpperCase(), pathStr, timestamp, nonce].join('\n');
  const signature = crypto.createHmac('sha256', config.clusterSecret)
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

  // 获取该节点的 secret
  const secret = getPeerSecret(nodeId);
  if (!secret) {
    return res.status(401).json({ error: `未知节点: ${nodeId}` });
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
    const headers = signRequest(method, url.pathname + url.search);
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
  const headers = signRequest('GET', url.pathname);

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
  const headers = signRequest('GET', url.pathname);

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
      version: '2.1.0'
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

  return router;
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
  proxyDownload,
  proxyPreview,
  createInternalRouter
};
