// ==================== 配置加载 ====================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const SNIPPETS_DIR = path.join(__dirname, '..', 'snippets');
const KEYS_FILE = path.join(__dirname, '..', 'keys.json');
const SNIPPETS_FILE = path.join(__dirname, '..', 'snippets.json');
const MAX_FILE_SIZE = 500 * 1024 * 1024;

// 加载管理员密钥
const envPath = path.join(__dirname, '..', '.env');
let ADMIN_KEY = process.env.CLOUD_DRIVE_ADMIN_KEY;

if (!ADMIN_KEY) {
  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/CLOUD_DRIVE_ADMIN_KEY=(.+)/);
      if (match) ADMIN_KEY = match[1].trim();
    }
  } catch (e) { /* ignore */ }
}

if (!ADMIN_KEY) {
  ADMIN_KEY = crypto.randomBytes(4).toString('hex');
  const envLine = `CLOUD_DRIVE_ADMIN_KEY=${ADMIN_KEY}\n`;
  try {
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf8');
      if (content.includes('CLOUD_DRIVE_ADMIN_KEY=')) {
        content = content.replace(/CLOUD_DRIVE_ADMIN_KEY=.*/, envLine.trim());
      } else {
        content += envLine;
      }
      fs.writeFileSync(envPath, content);
    } else {
      fs.writeFileSync(envPath, envLine);
    }
  } catch (e) { /* ignore */ }
}

// ==================== 集群配置 ====================

// 从 .env 文件读取值（process.env 优先）
let _envContent = null;
function _readEnvFile() {
  if (_envContent !== null) return _envContent;
  try {
    if (fs.existsSync(envPath)) _envContent = fs.readFileSync(envPath, 'utf8');
    else _envContent = '';
  } catch (e) { _envContent = ''; }
  return _envContent;
}
function getEnv(key, fallback) {
  if (process.env[key]) return process.env[key];
  const content = _readEnvFile();
  const match = content.match(new RegExp('^' + key + '=(.+)', 'm'));
  if (match) return match[1].trim();
  return fallback;
}

function parsePeers(peersStr) {
  if (!peersStr || !peersStr.trim()) return [];
  return peersStr.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const parts = entry.split('::');
    return {
      nodeId: parts[0]?.trim() || '',
      endpoint: parts[1]?.trim() || '',
      secret: parts[2]?.trim() || ''
    };
  }).filter(p => p.nodeId && p.endpoint);
}

// 检测服务器 IP
function detectServerIp() {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  } catch (e) { /* ignore */ }
  return 'localhost';
}

const serverIp = detectServerIp();
const PORT = parseInt(getEnv('PORT', '3002'), 10);
const publicEndpoint = getEnv('PUBLIC_ENDPOINT', `http://${serverIp}:${PORT}`);

const clusterNodeId = getEnv('CLUSTER_NODE_ID', serverIp);
const clusterNodeName = getEnv('CLUSTER_NODE_NAME', clusterNodeId);
const clusterSecret = getEnv('CLUSTER_SECRET', '');
const clusterPeersRaw = getEnv('CLUSTER_PEERS', '');
const clusterPeers = parsePeers(clusterPeersRaw);
const clusterEnabled = !!(clusterNodeId && clusterSecret && clusterPeers.length > 0);
const clusterTimeout = parseInt(getEnv('CLUSTER_TIMEOUT', '5000'), 10);
const clusterSignatureWindow = parseInt(getEnv('CLUSTER_SIGNATURE_WINDOW', '300'), 10);

module.exports = {
  PORT,
  UPLOAD_DIR,
  SNIPPETS_DIR,
  KEYS_FILE,
  SNIPPETS_FILE,
  MAX_FILE_SIZE,
  ADMIN_KEY,
  envPath,
  serverIp,
  publicEndpoint,
  // 集群
  clusterNodeId,
  clusterNodeName,
  clusterSecret,
  clusterPeers,
  clusterEnabled,
  clusterTimeout,
  clusterSignatureWindow
};
