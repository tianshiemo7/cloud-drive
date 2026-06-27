// ==================== 文件中转站 v2.2.0 — 树形文件系统 + 设置面板 ====================
// 支持单机独立模式 + 多节点对等网格集群模式

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

  // 查找已存在的根文件夹（可能来自之前的 nodeId）
  const existingRoots = Object.entries(folders).filter(([id, f]) => f.parent === null);

  if (existingRoots.length > 0 && !folders[rootId]) {
    // 有旧根文件夹，重命名第一个匹配 nodeId 的
    const [oldId] = existingRoots[0];
    if (oldId !== rootId) {
      folders[rootId] = { ...folders[oldId], name: config.clusterNodeName || rootId, nodeId: rootId };
      delete folders[oldId];
      // 更新旧文件夹下文件的引用
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
      console.log(`\u{1F4C1} 根文件夹已重命名: ${oldId} → ${rootId}`);
    }
  } else if (!folders[rootId]) {
    // 没有根文件夹，创建
    folders[rootId] = {
      name: config.clusterNodeName || rootId,
      parent: null,
      nodeId: rootId,
      createdAt: new Date().toISOString()
    };
    saveFolders(folders);
    console.log(`\u{1F4C1} 已创建节点根文件夹: ${rootId}`);
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
    console.log(`\u{1F4E6} 已迁移 ${moved} 个文件到 ${rootId}/`);
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

// ==================== 集群增强（始终启用，无对等节点时退化为独立模式） ====================

const cluster = require('./lib/cluster');

// 登录（含跨节点查找）
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

  // 跨节点查找（无对等节点时自动跳过）
  cluster.lookupKeyAcrossPeers(trimmedKey).then(result => {
    if (result && result.found) {
      req.session.role = 'viewer';
      req.session.fileKey = trimmedKey;
      req.session.filename = result.filename;
      req.session.sourceNodeId = result.nodeId;
      return res.json({ success: true, role: 'viewer', filename: result.filename, sourceNodeId: result.nodeId });
    }
    res.status(401).json({ error: '密钥无效' });
  }).catch(() => res.status(401).json({ error: '密钥无效' }));
});

// 文件列表（聚合，无对等节点时仅返回本地文件）
app.get('/api/files', requireAuth, (req, res) => {
  if (req.session.role === 'viewer') {
    const fn = req.session.filename;
    const fp = path.join(config.UPLOAD_DIR, fn);
    if (!fs.existsSync(fp)) return res.json({ files: [] });
    const stats = fs.statSync(fp);
    return res.json({ files: [{ name: fn, size: stats.size, modified: stats.mtime.toISOString() }] });
  }
  cluster.getAggregatedFiles().then(r => res.json(r)).catch(err => {
    console.error('聚合失败:', err.message);
    const { loadKeys } = require('./lib/persistence');
    const { isPreviewable } = require('./lib/utils');
    fs.readdir(config.UPLOAD_DIR, (e2, files) => {
      if (e2) return res.status(500).json({ error: '读取文件列表失败' });
      const keys = loadKeys();
      const list = files.filter(n => !n.startsWith('.')).map(name => {
        try {
          const s = fs.statSync(path.join(config.UPLOAD_DIR, name));
          const m = typeof keys[name] === 'string' ? { key: keys[name] } : (keys[name] || {});
          return { name, size: s.size, modified: s.mtime.toISOString(), key: m.key || null,
            expiresAt: m.expiresAt || null, oneTime: !!m.oneTime, downloadCount: m.downloadCount || 0,
            maxDownloads: m.maxDownloads || null, md5: m.md5 || null, preview: isPreviewable(name),
            folder: m.folder || null, nodeId: config.clusterNodeId };
        } catch (e) { return null; }
      }).filter(Boolean).sort((a, b) => b.modified.localeCompare(a.modified));
      res.json({ files: list, nodes: [{ nodeId: config.clusterNodeId, error: null }] });
    });
  });
});

// 下载（远程代理）
app.get('/api/download/:filename', requireAuth, (req, res) => {
  const fn = decodeURIComponent(req.params.filename);
  if (req.session.sourceNodeId && req.session.filename === fn)
    return cluster.proxyDownload(req.session.sourceNodeId, fn, res);
  return downloadHandler(req, res);
});

// 预览（远程代理）
app.get('/api/preview/:filename', requireAuth, (req, res) => {
  const fn = decodeURIComponent(req.params.filename);
  if (req.session.sourceNodeId && req.session.filename === fn)
    return cluster.proxyPreview(req.session.sourceNodeId, fn, res);
  return previewHandler(req, res);
});

// check
app.get('/api/check', (req, res) => {
  if (req.session.role === 'admin')
    return res.json({ authenticated: true, role: 'admin', csrf: req.session.csrf });
  if (req.session.role === 'viewer' && req.session.filename) {
    if (req.session.sourceNodeId)
      return res.json({ authenticated: true, role: 'viewer', filename: req.session.filename, sourceNodeId: req.session.sourceNodeId, oneTimeConsumed: false });
    const { loadKeys } = require('./lib/persistence');
    const keys = loadKeys();
    const m = typeof keys[req.session.filename] === 'string' ? { key: keys[req.session.filename] } : (keys[req.session.filename] || {});
    if (m && m.key === req.session.fileKey)
      return res.json({ authenticated: true, role: 'viewer', filename: req.session.filename, oneTimeConsumed: m.oneTime && m.downloadCount > 0 });
    req.session.destroy(() => {});
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: false });
});

// 集群文件夹聚合（无对等节点时仅返回本地方案）
app.get('/api/folders', requireAuth, (req, res) => {
  if (req.session.role === 'viewer') return res.json({ folders: [], grouped: {} });
  cluster.getAggregatedFolders().then(r => res.json(r)).catch(() => {
    const f = require('./lib/folders');
    res.json({ folders: f.buildTree(require('./lib/persistence').loadFolders(), null), grouped: {} });
  });
});

// 内部 API（始终注册，无对等节点时仅签注验证会拒绝未知请求）
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

// 🌐 一键连接：粘贴口令建立集群连接
app.post('/api/cluster/connect', requireAdmin, csrfCheck, (req, res) => {
  try {
    const { token } = req.body;
    if (!token || !token.trim()) return res.status(400).json({ error: '请输入连接口令' });
    const result = clusterConfig.connect(token.trim());
    // 如果此节点尚无集群密钥，自动继承对方的共享密钥
    if (!config.clusterSecret && result.sharedSecret) {
      config.clusterSecret = result.sharedSecret;
    }
    config.clusterEnabled = !!(config.clusterNodeId && config.clusterSecret && config.clusterPeers.length > 0);
    res.json({
      success: true,
      peer: { nodeId: result.peer.nodeId, endpoint: result.peer.endpoint },
      clusterEnabled: config.clusterEnabled,
      message: `已连接至 ${result.peer.nodeId}（${result.peer.endpoint}）`
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
    res.json({ success: true, config: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/cluster/peers/status', requireAdmin, async (req, res) => {
  try {
    const statuses = await cluster.checkAllPeers();
    res.json({ peers: statuses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 拓扑发现：预览接入一个节点会引入多少服务器
app.post('/api/cluster/discover', requireAdmin, csrfCheck, async (req, res) => {
  const { endpoint, secret } = req.body;
  if (!endpoint || !secret) return res.status(400).json({ error: '缺少 endpoint 或 secret' });
  try {
    const discovered = await cluster.discoverTopology(endpoint, secret);
    res.json({ discovered: discovered.map(d => ({ nodeId: d.nodeId, endpoint: d.endpoint })), totalCount: discovered.length + 1 });
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

// SPA Fallback — 添加 Clear-Site-Data 清理旧 SW 缓存
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/'))
    return res.status(404).json({ error: 'API 不存在' });
  // 首次加载时通知浏览器清理旧版 Service Worker 缓存
  res.set('Clear-Site-Data', '"cache"');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 启动 ====================

app.listen(config.PORT, () => {
  console.log('');
  console.log('\u{1F4C1}  文件中转站 v2.2.0 已启动');
  console.log(`   地址: http://127.0.0.1:${config.PORT}`);
  console.log(`   管理员密钥: ${config.ADMIN_KEY}`);
  console.log(`   存储目录: ${config.UPLOAD_DIR}`);
  if (config.clusterEnabled && config.clusterPeers.length > 0) {
    console.log(`   🌐 集群节点: ${config.clusterNodeId}${config.clusterNodeName ? ' (' + config.clusterNodeName + ')' : ''}`);
    console.log(`   对等节点: ${config.clusterPeers.map(p => `${p.nodeId} (${p.endpoint})`).join(', ')}`);
  } else {
    console.log('   模式: 独立运行（可通过连接口令加入集群）');
  }
  console.log('');
});
