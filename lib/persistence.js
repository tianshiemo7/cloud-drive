// ==================== 数据持久化 ====================

const path = require('path');
const fs = require('fs');
const config = require('./config');

const FOLDERS_FILE = require('path').join(__dirname, '..', 'folders.json');

function loadKeys() {
  try {
    if (fs.existsSync(config.KEYS_FILE)) return JSON.parse(fs.readFileSync(config.KEYS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}

function saveKeys(keys) {
  fs.writeFileSync(config.KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

function loadSnippets() {
  try {
    if (fs.existsSync(config.SNIPPETS_FILE)) return JSON.parse(fs.readFileSync(config.SNIPPETS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}

function saveSnippets(snippets) {
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
  try {
    if (fs.existsSync(FOLDERS_FILE)) return JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}

function saveFolders(folders) {
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(folders, null, 2), 'utf8');
}

module.exports = {
  loadKeys,
  saveKeys,
  loadSnippets,
  saveSnippets,
  loadFolders,
  saveFolders,
  cleanExpired
};
