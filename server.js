// ==================== 文件中转站 v3.1 — 集群底层重构 ====================
// v3.1: 内容哈希密钥 + clone 索引同步 + 双向连接 + 单文件存储
// 支持单机独立模式 + 多节点集群模式

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

// ==================== 加载配置 ====================

const config = require('./lib/config');

// 确保上传目录存在
[config.UPLOAD_DIR, config.SNIPPETS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// 加载运行时集群配置（覆盖 .env）
const clusterConfig = require('./lib/cluster-config');
clusterConfig.setConfigRef(config);
clusterConfig.load();

// ==================== 启动迁移：为当前节点创建根文件夹 ====================

(function migrateRootFolder() {
  const { loadFolders, saveFolders, loadKeys, saveKeys } = require('./lib/persistence');
  const folders = loadFolders();
  const rootId = config.clusterNodeId;

  const existingRoots = Object.entries(folders).filter(([id, f]) => f.parent === null);

  if (existingRoots.length > 0 && !folders[rootId]) {
    const [oldId] = existingRoots[0];
    if (oldId !== rootId) {
      folders[rootId] = { ...folders[oldId], name: config.clusterNodeName || rootId, nodeId: rootId };
      delete folders[oldId];
      const keys = loadKeys();
      let updated = 0;
      for (const [name, meta] of Object.entries(keys)) {
        const m = typeof meta === 'string' ? { key: meta } : meta;
        if (m.folder === oldId) {
          if (typeof keys[name] === 'string') keys[name] = { key: keys[name], folder: rootId };
          else keys[name].folder = rootId;
          updated++;
        }
      }
      if (updated > 0) saveKeys(keys);
      saveFolders(folders);
      console.log(`📁 根文件夹已重命名: ${oldId} → ${rootId}`);
    }
  } else if (!folders[rootId]) {
    folders[rootId] = {
      name: config.clusterNodeName || rootId,
      parent: null,
      nodeId: rootId,
      createdAt: new Date().toISOString()
    };
    saveFolders(folders);
    console.log(`📁 已创建节点根文件夹: ${rootId}`);
  }

  // 迁移 folder 为 null 或 folder 指向不存在节点的文件
  const keys = loadKeys();
  let moved = 0;
  for (const [name, meta] of Object.entries(keys)) {
    const m = typeof meta === 'string' ? { key: meta } : meta;
    if (!m.folder || !folders[m.folder]) {
      if (typeof keys[name] === 'string') {
        keys[name] = { key: keys[name], folder: rootId };
      } else {
        keys[name].folder = rootId;
      }
      moved++;
    }
  }
  if (moved > 0) {
    saveKeys(keys);
    console.log(`📦 已迁移 ${moved} 个文件到 ${rootId}/`);
  }
})();

// ==================== 加载模块 ====================

const { loginLimiter, uploadLimiter } = require('./lib/utils');
const {
  csrfCheck,
  requireAdmin,
  requireAuth,
  logoutHandler
} = require('./lib/auth');
const {
  uploadHandler,
  downloadHandler,
  deleteHandler,
  batchDeleteHandler,
  rekeyHandler,
  previewHandler,
  diskHandler,
  healthHandler,
  moveFileHandler
} = require('./lib/files');
const { createSnippetHandler, getSnippetHandler } = require('./lib/snippets');
const { handleMulterError } = require('./lib/utils');
const {
  createFolderHandler,
  deleteFolderHandler,
  renameFolderHandler
} = require('./lib/folders');

// ==================== 中间件 ====================

app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.use(express.json({ limit: '1mb' }));

// ==================== 集群（v3.0 极简设计：缓存索引 + 定期同步） ====================

const cluster = require('./lib/cluster');

// 登录（v3.0：密钥全局唯一，本地找不到即为无效）
app.post('/api/login', loginLimiter, (req, res) => {
  const { key } = req.body;
  if (!key || !key.trim()) return res.status(400).json({ error: '请输入密钥' });
  const trimmedKey = key.trim();

  if (trimmedKey === config.ADMIN_KEY) {
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: '登录失败' });
      req.session.role = 'admin';
      req.session.csrf = crypto.randomBytes(16).toString('hex');
      return res.json({ success: true, role: 'admin', csrf: req.session.csrf });
    });
    return;
  }

  // 本地查找（v3.0: 密钥已全局唯一，无需跨节点查找）
  const { loadKeys } = require('./lib/persistence');
  const keys = loadKeys();
  for (const [filename, meta] of Object.entries(keys)) {
    const m = typeof meta === 'string' ? { key: meta } : meta;
    if (m.key === trimmedKey) {
      if (m.expiresAt && Date.now() > new Date(m.expiresAt).getTime())
        return res.status(401).json({ error: '该密钥已过期' });
      if (m.maxDownloads && m.downloadCount >= m.maxDownloads)
        return res.status(401).json({ error: '该文件下载次数已用完' });
      req.session.role = 'viewer';
      req.session.fileKey = trimmedKey;
      req.session.filename = filename;
      req.session.sourceNodeId = null;
      return res.json({ success: true, role: 'viewer', filename });
    }
  }

  // v3.0: 缓存中查找——文件可能在对等节点上
  const cached = cluster.getCachedIndex();
  for (const f of cached.files) {
    if (f.key === trimmedKey && f.nodeId !== config.clusterNodeId) {
      if (f.expiresAt && Date.now() > new Date(f.expiresAt).getTime())
        return res.status(401).json({ error: '该密钥已过期' });
      if (f.maxDownloads && f.downloadCount >= f.maxDownloads)
        return res.status(401).json({ error: '该文件下载次数已用完' });
      req.session.role = 'viewer';
      req.session.fileKey = trimmedKey;
      req.session.filename = f.name;
      req.session.sourceNodeId = f.nodeId;
      return res.json({ success: true, role: 'viewer', filename: f.name, sourceNodeId: f.nodeId });
    }
  }

  res.status(401).json({ error: '密钥无效' });
});

// 文件列表（v3.0：读缓存，即时返回）
app.get('/api/files', requireAuth, (req, res) => {
  if (req.session.role === 'viewer') {
    const fn = req.session.filename;
    // 如果文件在远程节点，从缓存中找
    if (req.session.sourceNodeId) {
      const cached = cluster.getCachedIndex();
      const rf = cached.files.find(f => f.name === fn && f.nodeId === req.session.sourceNodeId);
      if (rf) return res.json({ files: [rf] });
    }
    const fp = path.join(config.UPLOAD_DIR, fn);
    if (!fs.existsSync(fp)) return res.json({ files: [] });
    const stats = fs.statSync(fp);
    return res.json({ files: [{ name: fn, size: stats.size, modified: stats.mtime.toISOString() }] });
  }

  // admin: 返回缓存索引（本地 + 所有在线对等节点）
  const result = cluster.getCachedIndex();
  res.json(result);
});

// 下载（v3.0：远程文件通过简化代理）
app.get('/api/download/:filename', requireAuth, (req, res) => {
  const fn = decodeURIComponent(req.params.filename);
  if (req.session.sourceNodeId && req.session.filename === fn)
    return cluster.proxyDownload(req.session.sourceNodeId, fn, res);
  return downloadHandler(req, res);
});

// 预览（v3.0：远程文件通过简化代理）
app.get('/api/preview/:filename', requireAuth, (req, res) => {
  const fn = decodeURIComponent(req.params.filename);
  if (req.session.sourceNodeId && req.session.filename === fn)
    return cluster.proxyPreview(req.session.sourceNodeId, fn, res);
  return previewHandler(req, res);
});

// 会话检查
app.get('/api/check', (req, res) => {
  if (req.session.role === 'admin')
    return res.json({ authenticated: true, role: 'admin', csrf: req.session.csrf });
  if (req.session.role === 'viewer' && req.session.filename) {
    if (req.session.sourceNodeId) {
      // 远程文件：检查缓存中是否仍存在
      const cached = cluster.getCachedIndex();
      const rf = cached.files.find(f =>
        f.name === req.session.filename && f.nodeId === req.session.sourceNodeId
      );
      if (rf) {
        return res.json({
          authenticated: true, role: 'viewer',
          filename: req.session.filename, sourceNodeId: req.session.sourceNodeId,
          oneTimeConsumed: false
        });
      }
      req.session.destroy(() => {});
      return res.json({ authenticated: false });
    }
    const { loadKeys } = require('./lib/persistence');
    const keys = loadKeys();
    const m = typeof keys[req.session.filename] === 'string'
      ? { key: keys[req.session.filename] }
      : (keys[req.session.filename] || {});
    if (m && m.key === req.session.fileKey)
      return res.json({
        authenticated: true, role: 'viewer', filename: req.session.filename,
        oneTimeConsumed: m.oneTime && m.downloadCount > 0
      });
    req.session.destroy(() => {});
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: false });
});

// 文件夹列表（v3.0：读缓存）
app.get('/api/folders', requireAuth, (req, res) => {
  if (req.session.role === 'viewer') return res.json({ folders: [], grouped: {} });
  const result = cluster.getCachedFolders();
  res.json(result);
});

// 内部 API（v3.0: 仅 2 个端点 — /clone 和 /file/:filename）
app.use('/api/internal', cluster.createInternalRouter());

// ==================== 通用路由 ====================

app.post('/api/logout', logoutHandler);
app.post('/api/upload', requireAdmin, csrfCheck, uploadLimiter, uploadHandler);
app.delete('/api/files/:filename', requireAdmin, csrfCheck, deleteHandler);
app.post('/api/files/delete-batch', requireAdmin, csrfCheck, batchDeleteHandler);
app.post('/api/files/:filename/rekey', requireAdmin, csrfCheck, rekeyHandler);
app.put('/api/files/:name/move', requireAdmin, csrfCheck, moveFileHandler);
app.get('/api/disk', requireAdmin, diskHandler);
app.get('/api/health', healthHandler);

// 文件夹 CRUD
app.post('/api/folders/create', requireAdmin, csrfCheck, createFolderHandler);
app.delete('/api/folders/:id', requireAdmin, csrfCheck, deleteFolderHandler);
app.put('/api/folders/:id/rename', requireAdmin, csrfCheck, renameFolderHandler);

// 🌐 一键连接：粘贴口令建立集群连接（双向）
app.post('/api/cluster/connect', requireAdmin, csrfCheck, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || !token.trim()) return res.status(400).json({ error: '请输入连接口令' });
    const result = await clusterConfig.connect(token.trim());
    if (!config.clusterSecret && result.sharedSecret) {
      config.clusterSecret = result.sharedSecret;
    }
    config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);
    // 连接新节点后立即同步一次
    cluster.syncFromPeers().catch(() => {});
    const msg = result.announced
      ? `🔗 双向连接成功: ${config.clusterNodeId} ↔ ${result.peer.nodeId}`
      : `已连接至 ${result.peer.nodeId}（${result.peer.endpoint}）`;
    res.json({
      success: true,
      peer: { nodeId: result.peer.nodeId, endpoint: result.peer.endpoint },
      announced: result.announced,
      clusterEnabled: config.clusterEnabled,
      message: msg
    });
  } catch (e) {
    res.status(400).json({ error: e.message || '连接口令无效' });
  }
});

// 集群设置 API
app.get('/api/cluster/settings', requireAdmin, (req, res) => {
  const cfg = clusterConfig.get();
  cfg.shareInfo = clusterConfig.getShareInfo();
  cfg.shareText = clusterConfig.getShareText();
  cfg.shareToken = clusterConfig.generateToken();
  cfg.lastSync = cluster.getLastSyncTime();
  res.json(cfg);
});
app.put('/api/cluster/settings', requireAdmin, csrfCheck, (req, res) => {
  try {
    const result = clusterConfig.save(req.body);
    res.json({ success: true, config: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/cluster/peers', requireAdmin, csrfCheck, (req, res) => {
  try {
    const result = clusterConfig.addPeer(req.body);
    res.json({ success: true, config: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/cluster/peers/:nodeId', requireAdmin, csrfCheck, (req, res) => {
  try {
    const result = clusterConfig.removePeer(req.params.nodeId);
    // 清理该节点缓存
    const cache = require('./lib/persistence').loadPeerCache();
    delete cache[req.params.nodeId];
    require('./lib/persistence').savePeerCache(cache);
    res.json({ success: true, config: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/cluster/peers/status', requireAdmin, async (req, res) => {
  try {
    const statuses = await cluster.checkAllPeers();
    res.json({ peers: statuses, lastSync: cluster.getLastSyncTime() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 文本片段
app.post('/api/snippets', requireAdmin, csrfCheck, createSnippetHandler);
app.get('/api/snippets/:key', getSnippetHandler);

// 静态文件 — 首次访问时通知浏览器清理旧 SW 缓存
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.set('Clear-Site-Data', '"cache"');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Multer 错误处理
app.use(handleMulterError);

// SPA Fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/'))
    return res.status(404).json({ error: 'API 不存在' });
  res.set('Clear-Site-Data', '"cache"');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 启动 ====================

app.listen(config.PORT, () => {
  console.log('');
  console.log('📁  文件中转站 v3.1 已启动');
  console.log(`   地址: http://127.0.0.1:${config.PORT}`);
  console.log(`   管理员密钥: ${config.ADMIN_KEY}`);
  console.log(`   存储目录: ${config.UPLOAD_DIR}`);
  console.log('   🔑 文件密钥: SHA-256 内容哈希 (全局唯一)');

  if (config.clusterEnabled && config.clusterPeers.length > 0) {
    console.log(`   🌐 集群节点: ${config.clusterNodeId}${config.clusterNodeName ? ' (' + config.clusterNodeName + ')' : ''}`);
    console.log(`   对等节点: ${config.clusterPeers.map(p => `${p.nodeId} (${p.endpoint})`).join(', ')}`);
    // v3.0: 启动定期同步
    cluster.startSyncLoop(config.syncIntervalMs);
  } else {
    console.log('   模式: 独立运行（可通过连接口令加入集群）');
  }
  console.log('');
});
