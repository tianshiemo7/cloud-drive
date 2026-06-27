// ==================== 运行时集群配置管理 ====================
// 优先于 .env，可通过 API 实时修改，无需重启

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'cluster-config.json');

let config = null; // 延迟引用，避免循环依赖

function setConfigRef(cfg) {
  config = cfg;
}

function load() {
  if (!config) return false;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (saved.nodeId) config.clusterNodeId = saved.nodeId;
      if (saved.nodeName || saved.nodeName === '') config.clusterNodeName = saved.nodeName;
      if (saved.peers) config.clusterPeers = saved.peers;
      config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function get() {
  if (!config) return null;
  return {
    nodeId: config.clusterNodeId,
    nodeName: config.clusterNodeName,
    secret: config.clusterSecret,
    peers: config.clusterPeers.map(p => ({ nodeId: p.nodeId, endpoint: p.endpoint })),
    enabled: config.clusterEnabled,
    timeout: config.clusterTimeout,
    signatureWindow: config.clusterSignatureWindow
  };
}

// 生成分享用的连接信息（含 secret）
function getShareInfo() {
  if (!config) return null;
  return JSON.stringify({
    nodeId: config.clusterNodeId,
    nodeName: config.clusterNodeName,
    endpoint: config.publicEndpoint,
    secret: config.clusterSecret
  });
}

// 简易文本格式分享（方便粘贴到聊天）
function getShareText() {
  if (!config) return '';
  return [
    `节点ID: ${config.clusterNodeId}`,
    `节点名称: ${config.clusterNodeName}`,
    `地址: ${config.publicEndpoint}`,
    `密钥: ${config.clusterSecret}`,
    ``,
    `--- 复制上面全部内容，在集群设置中点「粘贴分享信息」即可 ---`
  ].join('\n');
}

function save(newSettings) {
  if (!config) throw new Error('config not initialized');

  const data = {
    nodeId: newSettings.nodeId || config.clusterNodeId,
    nodeName: newSettings.nodeName !== undefined ? newSettings.nodeName : config.clusterNodeName,
    peers: newSettings.peers || config.clusterPeers
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');

  // 同步回 config 对象
  config.clusterNodeId = data.nodeId;
  config.clusterNodeName = data.nodeName;
  if (newSettings.peers) config.clusterPeers = newSettings.peers;
  config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);

  // 同步更新 .env 中的对应字段
  try {
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    const lines = envContent.split('\n');
    const setEnv = (key, val) => {
      const prefix = key + '=';
      const idx = lines.findIndex(l => l.startsWith(prefix));
      if (idx >= 0) lines[idx] = prefix + val;
      else lines.push(prefix + val);
    };
    setEnv('CLUSTER_NODE_ID', data.nodeId);
    setEnv('CLUSTER_NODE_NAME', data.nodeName || '');
    if (newSettings.peers) {
      const peersStr = newSettings.peers.map(p => `${p.nodeId}::${p.endpoint}::${p.secret || config.clusterSecret}`).join(',');
      setEnv('CLUSTER_PEERS', peersStr);
    }
    fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* ignore */ }

  return get();
}

function addPeer(peer) {
  if (!config) throw new Error('config not initialized');
  // 禁止添加自己为对等节点
  if (peer.nodeId === config.clusterNodeId) {
    throw new Error('不能添加自己为对等节点');
  }
  // 检查是否已存在
  const exists = config.clusterPeers.findIndex(p => p.nodeId === peer.nodeId);
  if (exists >= 0) {
    config.clusterPeers[exists] = peer;
  } else {
    config.clusterPeers.push(peer);
  }
  config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);
  return save({ peers: config.clusterPeers });
}

function removePeer(nodeId) {
  if (!config) throw new Error('config not initialized');
  config.clusterPeers = config.clusterPeers.filter(p => p.nodeId !== nodeId);
  config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);
  return save({ peers: config.clusterPeers });
}

// ==================== 一键连接口令 ====================

const TOKEN_PREFIX = 'CDC02:';

function generateToken() {
  if (!config) return '';
  // 如果尚未配置共享密钥，自动生成一个
  if (!config.clusterSecret || !config.clusterSecret.trim()) {
    const crypto = require('crypto');
    config.clusterSecret = crypto.randomBytes(32).toString('hex');
    // 持久化到 .env
    try {
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8');
      const lines = envContent.split('\n');
      const idx = lines.findIndex(l => l.startsWith('CLUSTER_SECRET='));
      if (idx >= 0) lines[idx] = 'CLUSTER_SECRET=' + config.clusterSecret;
      else lines.push('CLUSTER_SECRET=' + config.clusterSecret);
      fs.writeFileSync(envPath, lines.filter(l => l.trim()).join('\n') + '\n', 'utf8');
    } catch (e) { /* ignore */ }
    console.log('🔑 已自动生成集群共享密钥');
  }
  const payload = JSON.stringify({
    n: config.clusterNodeId,
    m: config.clusterNodeName || '',
    a: config.publicEndpoint,
    s: config.clusterSecret
  });
  return TOKEN_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

function parseToken(token) {
  if (!token || typeof token !== 'string') throw new Error('口令不能为空');
  // 支持旧版多行分享文本（兼容）
  if (token.includes('\n') || token.includes('节点ID:')) {
    return parseLegacyShareText(token);
  }
  if (!token.startsWith(TOKEN_PREFIX)) {
    // 尝试直接解析 JSON（兼容旧的 JSON 格式）
    try {
      const info = JSON.parse(token);
      if (info.nodeId && info.endpoint && info.secret) {
        return { nodeId: info.nodeId, nodeName: info.nodeName, endpoint: info.endpoint, secret: info.secret };
      }
    } catch (e) { /* fall through */ }
    throw new Error('无效的连接口令格式，应为 CDC02: 开头');
  }
  const b64 = token.slice(TOKEN_PREFIX.length);
  let json;
  try {
    json = Buffer.from(b64, 'base64url').toString('utf8');
  } catch (e) {
    throw new Error('口令解码失败');
  }
  let payload;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    throw new Error('口令内容格式无效');
  }
  const nodeId = payload.n;
  const endpoint = payload.a;
  const secret = payload.s;
  const nodeName = payload.m || nodeId;
  if (!nodeId || !endpoint || !secret) {
    throw new Error('口令缺少必要信息（节点ID/地址/密钥）');
  }
  return { nodeId, nodeName, endpoint, secret };
}

function parseLegacyShareText(text) {
  // 解析旧格式：
  // 节点ID: xxx
  // 节点名称: xxx
  // 地址: http://...
  // 密钥: xxx
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

function connect(token) {
  if (!config) throw new Error('config not initialized');
  const peer = parseToken(token);

  // 禁止连接自己
  if (peer.nodeId === config.clusterNodeId) {
    throw new Error('不能连接自己，请将口令发给其他节点使用');
  }

  // 检查是否已存在同名节点
  const exists = config.clusterPeers.findIndex(p => p.nodeId === peer.nodeId);
  if (exists >= 0) {
    config.clusterPeers[exists] = { ...peer };
  } else {
    config.clusterPeers.push(peer);
  }
  config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);

  // 持久化：更新 cluster-config.json
  try {
    const data = {
      nodeId: config.clusterNodeId,
      nodeName: config.clusterNodeName,
      peers: config.clusterPeers
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { /* ignore */ }

  // 持久化：同步到 .env
  try {
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    const lines = envContent.split('\n');
    const setEnv = (key, val) => {
      const prefix = key + '=';
      const idx = lines.findIndex(l => l.startsWith(prefix));
      if (idx >= 0) lines[idx] = prefix + val;
      else lines.push(prefix + val);
    };
    // 如果本节点没有 secret，自动继承对方的（共享密钥）
    if (!config.clusterSecret || !config.clusterSecret.trim()) {
      config.clusterSecret = peer.secret;
      setEnv('CLUSTER_SECRET', peer.secret);
    }
    setEnv('CLUSTER_PEERS', config.clusterPeers.map(p =>
      `${p.nodeId}::${p.endpoint}::${p.secret || config.clusterSecret}`
    ).join(','));
    if (!lines.find(l => l.startsWith('CLUSTER_NODE_ID='))) {
      setEnv('CLUSTER_NODE_ID', config.clusterNodeId);
    }
    if (!lines.find(l => l.startsWith('CLUSTER_NODE_NAME='))) {
      setEnv('CLUSTER_NODE_NAME', config.clusterNodeName || '');
    }
    fs.writeFileSync(envPath, lines.filter(l => l.trim()).join('\n') + '\n', 'utf8');
  } catch (e) { /* ignore */ }

  return { peer, sharedSecret: peer.secret };
}

module.exports = { setConfigRef, load, get, getShareInfo, getShareText, save, addPeer, removePeer, generateToken, connect };
