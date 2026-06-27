// ==================== 配置加载 ====================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3002;
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

const clusterNodeId = process.env.CLUSTER_NODE_ID || '';
const clusterNodeName = process.env.CLUSTER_NODE_NAME || clusterNodeId || '';
const clusterSecret = process.env.CLUSTER_SECRET || '';
const clusterPeersRaw = process.env.CLUSTER_PEERS || '';
const clusterPeers = parsePeers(clusterPeersRaw);
const clusterEnabled = !!(clusterNodeId && clusterSecret && clusterPeers.length > 0);
const clusterTimeout = parseInt(process.env.CLUSTER_TIMEOUT, 10) || 5000;
const clusterSignatureWindow = parseInt(process.env.CLUSTER_SIGNATURE_WINDOW, 10) || 300;

module.exports = {
  PORT,
  UPLOAD_DIR,
  SNIPPETS_DIR,
  KEYS_FILE,
  SNIPPETS_FILE,
  MAX_FILE_SIZE,
  ADMIN_KEY,
  envPath,
  // 集群
  clusterNodeId,
  clusterNodeName,
  clusterSecret,
  clusterPeers,
  clusterEnabled,
  clusterTimeout,
  clusterSignatureWindow
};
