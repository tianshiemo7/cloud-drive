// ==================== 集群配置管理 v3.0 ====================
// 所有关联云盘信息存储在单一文件 cluster-nodes.json 中
// 支持双向连接、一键连接口令

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NODES_FILE = path.join(__dirname, '..', 'cluster-nodes.json');
const OLD_CONFIG_FILE = path.join(__dirname, '..', 'cluster-config.json');
const TOKEN_PREFIX = 'CDC03:'; // v3.0 口令前缀

let config = null; // 延迟引用全局 config 对象

function setConfigRef(cfg) {
  config = cfg;
}

// ==================== 数据加载/保存 ====================

function loadNodes() {
  try {
    if (fs.existsSync(NODES_FILE)) {
      return JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveNodes(data) {
  fs.writeFileSync(NODES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 迁移旧配置
function migrateOldConfig() {
  let nodes = { self: {}, secret: '', peers: {} };
  let migrated = false;

  // 从旧 cluster-config.json 读取
  try {
    if (fs.existsSync(OLD_CONFIG_FILE)) {
      const old = JSON.parse(fs.readFileSync(OLD_CONFIG_FILE, 'utf8'));
      if (old.nodeId) nodes.self.nodeId = old.nodeId;
      if (old.nodeName) nodes.self.nodeName = old.nodeName;
      if (old.peers) {
        for (const p of old.peers) {
          nodes.peers[p.nodeId] = {
            nodeId: p.nodeId,
            nodeName: p.nodeId,
            endpoint: p.endpoint,
            addedAt: new Date().toISOString(),
            lastSeen: null,
            online: false,
            fileCount: 0,
            error: null
          };
        }
      }
      migrated = true;
      // 迁移后删除旧文件
      try { fs.unlinkSync(OLD_CONFIG_FILE); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // 从 .env 补充
  if (config) {
    if (!nodes.self.nodeId) nodes.self.nodeId = config.clusterNodeId;
    if (!nodes.self.nodeName) nodes.self.nodeName = config.clusterNodeName;
    nodes.self.endpoint = config.publicEndpoint;
    nodes.secret = config.clusterSecret || '';

    // 合并 .env 中的 peers（如果尚未在 nodes 中）
    for (const p of config.clusterPeers) {
      if (!nodes.peers[p.nodeId]) {
        nodes.peers[p.nodeId] = {
          nodeId: p.nodeId,
          nodeName: p.nodeId,
          endpoint: p.endpoint,
          addedAt: new Date().toISOString(),
          lastSeen: null,
          online: false,
          fileCount: 0,
          error: null
        };
        migrated = true;
      }
    }
  }

  if (migrated || !fs.existsSync(NODES_FILE)) {
    saveNodes(nodes);
    console.log('📄 已创建 cluster-nodes.json（所有关联云盘）');
  }
  return nodes;
}

// ==================== 初始化 ====================

function load() {
  if (!config) return false;

  let nodes = loadNodes();
  if (!nodes) {
    nodes = migrateOldConfig();
  }

  // 同步到全局 config
  config.clusterNodeId = nodes.self.nodeId || config.clusterNodeId;
  config.clusterNodeName = nodes.self.nodeName || config.clusterNodeName;
  if (nodes.secret) config.clusterSecret = nodes.secret;

  // 同步 peers 到 config.clusterPeers（兼容旧代码）
  config.clusterPeers = [];
  for (const [id, p] of Object.entries(nodes.peers)) {
    config.clusterPeers.push({
      nodeId: p.nodeId,
      endpoint: p.endpoint,
      secret: nodes.secret || config.clusterSecret
    });
  }
  config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);

  // 确保自引用更新
  nodes.self.nodeId = config.clusterNodeId;
  nodes.self.nodeName = config.clusterNodeName;
  nodes.self.endpoint = config.publicEndpoint;
  if (!nodes.secret) nodes.secret = config.clusterSecret;
  saveNodes(nodes);

  return true;
}

// ==================== 查询接口 ====================

function get() {
  const nodes = loadNodes() || { self: {}, secret: '', peers: {} };
  const peerList = Object.values(nodes.peers).map(p => ({
    nodeId: p.nodeId,
    nodeName: p.nodeName,
    endpoint: p.endpoint,
    online: !!p.online,
    fileCount: p.fileCount || 0,
    lastSeen: p.lastSeen || null,
    addedAt: p.addedAt || null
  }));

  return {
    nodeId: nodes.self.nodeId || config?.clusterNodeId,
    nodeName: nodes.self.nodeName || config?.clusterNodeName,
    endpoint: nodes.self.endpoint || config?.publicEndpoint,
    secret: nodes.secret || config?.clusterSecret,
    peers: peerList,
    peerCount: peerList.length,
    enabled: !!(nodes.self.nodeId && nodes.secret && peerList.length > 0),
    timeout: config?.clusterTimeout || 5000
  };
}

function getShareInfo() {
  const nodes = loadNodes() || { self: {}, secret: '' };
  return JSON.stringify({
    nodeId: nodes.self.nodeId,
    nodeName: nodes.self.nodeName,
    endpoint: nodes.self.endpoint,
    secret: nodes.secret
  });
}

function getShareText() {
  const nodes = loadNodes() || { self: {}, secret: '' };
  return [
    `节点ID: ${nodes.self.nodeId}`,
    `节点名称: ${nodes.self.nodeName}`,
    `地址: ${nodes.self.endpoint}`,
    `密钥: ${nodes.secret}`,
    '',
    `--- 复制上面全部内容，在集群设置中点「一键连接」即可 ---`
  ].join('\n');
}

// ==================== 写入 ====================

function save(newSettings) {
  const nodes = loadNodes() || { self: {}, secret: '', peers: {} };

  if (newSettings.nodeId) nodes.self.nodeId = newSettings.nodeId;
  if (newSettings.nodeName !== undefined) nodes.self.nodeName = newSettings.nodeName;
  if (newSettings.endpoint) nodes.self.endpoint = newSettings.endpoint;

  // 更新 peers
  if (newSettings.peers) {
    const newPeers = {};
    for (const p of newSettings.peers) {
      const existing = nodes.peers[p.nodeId];
      newPeers[p.nodeId] = {
        nodeId: p.nodeId,
        nodeName: p.nodeName || existing?.nodeName || p.nodeId,
        endpoint: p.endpoint,
        addedAt: existing?.addedAt || new Date().toISOString(),
        lastSeen: existing?.lastSeen || null,
        online: existing?.online || false,
        fileCount: existing?.fileCount || 0,
        error: existing?.error || null
      };
    }
    nodes.peers = newPeers;
  }

  saveNodes(nodes);
  syncToConfig(nodes);
  return get();
}

// ==================== 对等节点管理 ====================

function addPeer(peer) {
  const nodes = loadNodes() || { self: {}, secret: '', peers: {} };

  if (peer.nodeId === nodes.self.nodeId) {
    throw new Error('不能添加自己为对等节点');
  }

  nodes.peers[peer.nodeId] = {
    nodeId: peer.nodeId,
    nodeName: peer.nodeName || peer.nodeId,
    endpoint: peer.endpoint,
    addedAt: new Date().toISOString(),
    lastSeen: null,
    online: false,
    fileCount: 0,
    error: null
  };

  saveNodes(nodes);
  syncToConfig(nodes);
  return get();
}

function removePeer(nodeId) {
  const nodes = loadNodes() || { self: {}, secret: '', peers: {} };
  delete nodes.peers[nodeId];
  saveNodes(nodes);
  syncToConfig(nodes);
  return get();
}

// ==================== 双向连接 ====================

// v3.0: 向目标节点宣告自己，实现双向连接
async function announceToPeer(peerEndpoint, secret) {
  const nodes = loadNodes();
  if (!nodes) throw new Error('未初始化集群配置');

  const http = require('http');
  const https = require('https');

  return new Promise((resolve, reject) => {
    const url = new URL('/api/internal/announce', peerEndpoint);
    const body = JSON.stringify({
      nodeId: nodes.self.nodeId,
      nodeName: nodes.self.nodeName,
      endpoint: nodes.self.endpoint
    });

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cluster-Secret': secret
      },
      timeout: 5000
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) reject(new Error(data.error || `HTTP ${res.statusCode}`));
          else resolve(data);
        } catch (e) {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve({ success: true });
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('宣告超时')); });
    req.write(body);
    req.end();
  });
}

// 被远程节点宣告——对方连接我们，我们也记录对方
function acceptAnnounce(info) {
  const nodes = loadNodes();
  if (!nodes) return false;

  if (info.nodeId === nodes.self.nodeId) return false;

  const existing = nodes.peers[info.nodeId];
  nodes.peers[info.nodeId] = {
    nodeId: info.nodeId,
    nodeName: info.nodeName || info.nodeId,
    endpoint: info.endpoint,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    online: true,
    fileCount: existing?.fileCount || 0,
    error: null
  };

  saveNodes(nodes);
  syncToConfig(nodes);
  return true;
}

// ==================== 一键连接口令 ====================

function generateToken() {
  const nodes = loadNodes() || { self: {}, secret: '' };

  // 如果没有共享密钥，自动生成
  if (!nodes.secret || !nodes.secret.trim()) {
    nodes.secret = crypto.randomBytes(32).toString('hex');
    saveNodes(nodes);
    if (config) config.clusterSecret = nodes.secret;
    // 同步到 .env
    syncSecretToEnv(nodes.secret);
  }

  const payload = JSON.stringify({
    n: nodes.self.nodeId,
    m: nodes.self.nodeName || '',
    a: nodes.self.endpoint,
    s: nodes.secret
  });
  return TOKEN_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

function parseToken(token) {
  if (!token || typeof token !== 'string') throw new Error('口令不能为空');

  // 兼容旧版多行分享文本
  if (token.includes('\n') || token.includes('节点ID:')) {
    return parseLegacyShareText(token);
  }

  // 兼容 CDC02 旧格式
  if (token.startsWith('CDC02:') || token.startsWith('CDC03:')) {
    const prefix = token.startsWith('CDC02:') ? 'CDC02:' : 'CDC03:';
    const b64 = token.slice(prefix.length);
    let json;
    try { json = Buffer.from(b64, 'base64url').toString('utf8'); }
    catch (e) { throw new Error('口令解码失败'); }
    let payload;
    try { payload = JSON.parse(json); }
    catch (e) { throw new Error('口令内容格式无效'); }
    const nodeId = payload.n;
    const endpoint = payload.a;
    const secret = payload.s;
    const nodeName = payload.m || nodeId;
    if (!nodeId || !endpoint || !secret) throw new Error('口令缺少必要信息');
    return { nodeId, nodeName, endpoint, secret };
  }

  // 尝试直接解析 JSON
  try {
    const info = JSON.parse(token);
    if (info.nodeId && info.endpoint && info.secret) {
      return { nodeId: info.nodeId, nodeName: info.nodeName, endpoint: info.endpoint, secret: info.secret };
    }
  } catch (e) { /* fall through */ }

  throw new Error('无效的连接口令格式');
}

function parseLegacyShareText(text) {
  const lines = text.split('\n');
  const result = {};
  for (const line of lines) {
    const match = line.match(/^(.+?)[:：]\s*(.+)/);
    if (!match) continue;
    const key = match[1].trim();
    const val = match[2].trim();
    if (key.includes('节点ID')) result.nodeId = val;
    else if (key.includes('节点名称')) result.nodeName = val;
    else if (key.includes('地址')) result.endpoint = val;
    else if (key.includes('密钥')) result.secret = val;
  }
  if (!result.nodeId || !result.endpoint || !result.secret) {
    throw new Error('旧版分享信息不完整，请对方使用新版生成连接口令');
  }
  return result;
}

async function connect(token) {
  const peer = parseToken(token);
  const nodes = loadNodes() || { self: {}, secret: '', peers: {} };

  // 禁止连接自己
  if (peer.nodeId === nodes.self.nodeId) {
    throw new Error('不能连接自己，请将口令发给其他节点使用');
  }

  // 如果本节点没有共享密钥，继承对方的
  if (!nodes.secret || !nodes.secret.trim()) {
    nodes.secret = peer.secret;
    syncSecretToEnv(peer.secret);
  }

  // 添加对方
  nodes.peers[peer.nodeId] = {
    nodeId: peer.nodeId,
    nodeName: peer.nodeName || peer.nodeId,
    endpoint: peer.endpoint,
    addedAt: new Date().toISOString(),
    lastSeen: null,
    online: false,
    fileCount: 0,
    error: null
  };

  saveNodes(nodes);
  syncToConfig(nodes);

  // 🔄 v3.0 双向连接：向对方宣告自己
  let announced = false;
  try {
    await announceToPeer(peer.endpoint, peer.secret);
    nodes.peers[peer.nodeId].lastSeen = new Date().toISOString();
    nodes.peers[peer.nodeId].online = true;
    saveNodes(nodes);
    announced = true;
    console.log(`🔗 双向连接成功: ${nodes.self.nodeId} ↔ ${peer.nodeId}`);
  } catch (e) {
    // 对方不可达或版本较低不支持 announce，静默降级
    console.log(`⚠ 双向宣告失败（对方可能为旧版本）: ${e.message}`);
  }

  return { peer, announced, sharedSecret: peer.secret };
}

// ==================== 辅助函数 ====================

function syncToConfig(nodes) {
  if (!config) return;
  config.clusterNodeId = nodes.self.nodeId || config.clusterNodeId;
  config.clusterNodeName = nodes.self.nodeName || config.clusterNodeName;
  if (nodes.secret) config.clusterSecret = nodes.secret;

  config.clusterPeers = [];
  for (const [id, p] of Object.entries(nodes.peers)) {
    config.clusterPeers.push({
      nodeId: p.nodeId,
      endpoint: p.endpoint,
      secret: nodes.secret || config.clusterSecret
    });
  }
  config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);
}

function syncSecretToEnv(secret) {
  if (!config) return;
  try {
    const envPath = path.join(__dirname, '..', '.env');
    let content = '';
    if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.startsWith('CLUSTER_SECRET='));
    if (idx >= 0) lines[idx] = 'CLUSTER_SECRET=' + secret;
    else lines.push('CLUSTER_SECRET=' + secret);
    fs.writeFileSync(envPath, lines.filter(l => l.trim()).join('\n') + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

// 更新对等节点状态（由 cluster.js 同步后调用）
function updatePeerStatus(nodeId, status) {
  const nodes = loadNodes();
  if (!nodes || !nodes.peers[nodeId]) return;
  Object.assign(nodes.peers[nodeId], status);
  saveNodes(nodes);
}

module.exports = {
  setConfigRef,
  load,
  get,
  getShareInfo,
  getShareText,
  save,
  addPeer,
  removePeer,
  announceToPeer,
  acceptAnnounce,
  generateToken,
  connect,
  updatePeerStatus,
  NODES_FILE
};
