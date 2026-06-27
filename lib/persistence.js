// ==================== 数据持久化 ====================

const path = require('path');
const fs = require('fs');
const config = require('./config');

const FOLDERS_FILE = require('path').join(__dirname, '..', 'folders.json');
const PEER_CACHE_FILE = require('path').join(__dirname, '..', 'peer-cache.json');

// ===== 内存缓存 =====
let _keysCache = null;
let _foldersCache = null;
let _snippetsCache = null;
let _peerCacheCache = null;

function loadKeys() {
  if (_keysCache !== null) return _keysCache;
  try {
    if (fs.existsSync(config.KEYS_FILE)) {
      _keysCache = JSON.parse(fs.readFileSync(config.KEYS_FILE, 'utf8'));
      return _keysCache;
    }
  } catch (e) { /* ignore */ }
  _keysCache = {};
  return _keysCache;
}

function saveKeys(keys) {
  _keysCache = keys;
  fs.writeFileSync(config.KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

function invalidateKeysCache() {
  _keysCache = null;
}

function loadSnippets() {
  if (_snippetsCache !== null) return _snippetsCache;
  try {
    if (fs.existsSync(config.SNIPPETS_FILE)) {
      _snippetsCache = JSON.parse(fs.readFileSync(config.SNIPPETS_FILE, 'utf8'));
      return _snippetsCache;
    }
  } catch (e) { /* ignore */ }
  _snippetsCache = {};
  return _snippetsCache;
}

function saveSnippets(snippets) {
  _snippetsCache = snippets;
  fs.writeFileSync(config.SNIPPETS_FILE, JSON.stringify(snippets, null, 2), 'utf8');
}

// ===== 自动清理过期文件 =====

function cleanExpired() {
  const keys = loadKeys();
  const now = Date.now();
  let changed = false;

  for (const [filename, meta] of Object.entries(keys)) {
    const m = typeof meta === 'string' ? { key: meta } : meta;
    if (m.expiresAt && now > new Date(m.expiresAt).getTime()) {
      const fp = path.join(config.UPLOAD_DIR, filename);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
      delete keys[filename];
      changed = true;
      console.log(`\u{1F5D1} 已清理过期文件: ${filename}`);
    }
  }

  if (changed) saveKeys(keys);
}

// 在模块加载时启动清理循环
cleanExpired();
setInterval(cleanExpired, 60 * 60 * 1000);

// ===== 文件夹持久化 =====

function loadFolders() {
  if (_foldersCache !== null) return _foldersCache;
  try {
    if (fs.existsSync(FOLDERS_FILE)) {
      _foldersCache = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
      return _foldersCache;
    }
  } catch (e) { /* ignore */ }
  _foldersCache = {};
  return _foldersCache;
}

function saveFolders(folders) {
  _foldersCache = folders;
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(folders, null, 2), 'utf8');
}

// v3.0: 对等节点索引缓存持久化
function loadPeerCache() {
  if (_peerCacheCache !== null) return _peerCacheCache;
  try {
    if (fs.existsSync(PEER_CACHE_FILE)) {
      _peerCacheCache = JSON.parse(fs.readFileSync(PEER_CACHE_FILE, 'utf8'));
      return _peerCacheCache;
    }
  } catch (e) { /* ignore */ }
  _peerCacheCache = {};
  return _peerCacheCache;
}

function savePeerCache(cache) {
  _peerCacheCache = cache;
  fs.writeFileSync(PEER_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

module.exports = {
  loadKeys,
  saveKeys,
  invalidateKeysCache,
  loadSnippets,
  saveSnippets,
  loadFolders,
  saveFolders,
  loadPeerCache,
  savePeerCache,
  cleanExpired
};
