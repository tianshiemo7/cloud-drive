// ==================== 文件中转站 v2.1.0 — 分布式架构 ====================
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

// ==================== 加载模块 ====================

const { loginLimiter } = require('./lib/utils');
const {
  csrfCheck,
  requireAdmin,
  requireAuth,
  loginHandler,
  logoutHandler,
  checkHandler
} = require('./lib/auth');
const {
  filesListHandler,
  uploadHandler,
  downloadHandler,
  deleteHandler,
  batchDeleteHandler,
  rekeyHandler,
  previewHandler,
  diskHandler,
  healthHandler
} = require('./lib/files');
const { createSnippetHandler, getSnippetHandler } = require('./lib/snippets');
const { handleMulterError } = require('./lib/utils');

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

// ==================== 集群增强 ====================

// 如果启用了集群，加载集群模块并注入增强钩子
let cluster = null;
if (config.clusterEnabled) {
  cluster = require('./lib/cluster');

  // 注入：登录时跨节点查找文件密钥
  const originalLoginHandler = loginHandler;
  app.post('/api/login', loginLimiter, (req, res) => {
    // 扩展 req，使得 auth.js 在本地找不到密钥时可以回调集群查找
    req._tryCrossNodeLookup = async (trimmedKey) => {
      try {
        const result = await cluster.lookupKeyAcrossPeers(trimmedKey);
        if (result && result.found) {
          req.session.role = 'viewer';
          req.session.fileKey = trimmedKey;
          req.session.filename = result.filename;
          req.session.sourceNodeId = result.nodeId;
          return res.json({ success: true, role: 'viewer', filename: result.filename, sourceNodeId: result.nodeId });
        }
      } catch (e) { /* 集群查找失败，继续返回密钥无效 */ }
      res.status(401).json({ error: '密钥无效' });
    };

    // 覆盖 loginHandler 中的跨节点查找逻辑
    // 直接在这里处理完整的登录流程
    const { key } = req.body;
    if (!key || !key.trim()) return res.status(400).json({ error: '请输入密钥' });

    const trimmedKey = key.trim();

    // 检查管理员密钥
    if (trimmedKey === config.ADMIN_KEY) {
      req.session.role = 'admin';
      req.session.csrf = crypto.randomBytes(16).toString('hex');
      return res.json({ success: true, role: 'admin', csrf: req.session.csrf });
    }

    // 检查本地文件密钥
    const { loadKeys } = require('./lib/persistence');
    const keys = loadKeys();
    for (const [filename, meta] of Object.entries(keys)) {
      const m = typeof meta === 'string' ? { key: meta } : meta;
      if (m.key === trimmedKey) {
        if (m.expiresAt && Date.now() > new Date(m.expiresAt).getTime()) {
          return res.status(401).json({ error: '该密钥已过期' });
        }
        if (m.maxDownloads && m.downloadCount >= m.maxDownloads) {
          return res.status(401).json({ error: '该文件下载次数已用完' });
        }
        req.session.role = 'viewer';
        req.session.fileKey = trimmedKey;
        req.session.filename = filename;
        req.session.sourceNodeId = null;
        return res.json({ success: true, role: 'viewer', filename });
      }
    }

    // 跨节点查找
    return req._tryCrossNodeLookup(trimmedKey);
  });

  // 注入：文件列表聚合远程文件
  app.get('/api/files', requireAuth, (req, res) => {
    if (req.session.role === 'viewer') {
      const filename = req.session.filename;
      const filePath = path.join(config.UPLOAD_DIR, filename);
      if (!fs.existsSync(filePath)) return res.json({ files: [] });
      const stats = fs.statSync(filePath);
      return res.json({ files: [{ name: filename, size: stats.size, modified: stats.mtime.toISOString() }] });
    }

    // admin: 聚合本地 + 远程
    cluster.getAggregatedFiles().then(result => {
      res.json(result);
    }).catch(err => {
      console.error('文件聚合失败:', err.message);
      // 降级：只返回本地文件
      const { loadKeys } = require('./lib/persistence');
      const { isPreviewable } = require('./lib/utils');
      fs.readdir(config.UPLOAD_DIR, (err2, files) => {
        if (err2) return res.status(500).json({ error: '读取文件列表失败' });
        const keys = loadKeys();
        const fileList = files
          .filter(n => !n.startsWith('.'))
          .map(name => {
            const fp = path.join(config.UPLOAD_DIR, name);
            try {
              const stats = fs.statSync(fp);
              const meta = keys[name];
              const m = typeof meta === 'string' ? { key: meta } : (meta || {});
              return {
                name, size: stats.size, modified: stats.mtime.toISOString(),
                key: m.key || null, expiresAt: m.expiresAt || null,
                oneTime: !!m.oneTime, downloadCount: m.downloadCount || 0,
                maxDownloads: m.maxDownloads || null, md5: m.md5 || null,
                preview: isPreviewable(name),
                nodeId: config.clusterNodeId
              };
            } catch (e) { return null; }
          })
          .filter(Boolean)
          .sort((a, b) => b.modified.localeCompare(a.modified));
        res.json({ files: fileList, nodes: [{ nodeId: config.clusterNodeId, error: null }] });
      });
    });
  });

  // 注入：下载支持远程代理
  app.get('/api/download/:filename', requireAuth, (req, res) => {
    const filename = decodeURIComponent(req.params.filename);

    // 检查是否是远程文件（viewer session 中有 sourceNodeId）
    if (req.session.sourceNodeId && req.session.filename === filename) {
      return cluster.proxyDownload(req.session.sourceNodeId, filename, res);
    }

    // 本地文件下载（使用原始处理逻辑）
    return downloadHandler(req, res);
  });

  // 注入：预览支持远程代理
  app.get('/api/preview/:filename', requireAuth, (req, res) => {
    const filename = decodeURIComponent(req.params.filename);

    if (req.session.sourceNodeId && req.session.filename === filename) {
      return cluster.proxyPreview(req.session.sourceNodeId, filename, res);
    }

    return previewHandler(req, res);
  });

  // 注入：check 支持远程 viewer
  app.get('/api/check', (req, res) => {
    if (req.session.role === 'admin') {
      return res.json({ authenticated: true, role: 'admin', csrf: req.session.csrf });
    }
    if (req.session.role === 'viewer' && req.session.filename) {
      if (req.session.sourceNodeId) {
        // 远程文件 viewer：信任 session
        return res.json({
          authenticated: true, role: 'viewer',
          filename: req.session.filename,
          sourceNodeId: req.session.sourceNodeId,
          oneTimeConsumed: false
        });
      }
      // 本地文件 viewer
      const { loadKeys } = require('./lib/persistence');
      const keys = loadKeys();
      const meta = keys[req.session.filename];
      const m = typeof meta === 'string' ? { key: meta } : meta;
      if (m && m.key === req.session.fileKey) {
        return res.json({
          authenticated: true, role: 'viewer',
          filename: req.session.filename,
          oneTimeConsumed: m.oneTime && m.downloadCount > 0
        });
      }
      req.session.destroy(() => {});
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: false });
  });

  // 挂载集群内部 API
  app.use('/api/internal', cluster.createInternalRouter());

  console.log(`\u{1F310} 集群模式已启用 · 节点: ${config.clusterNodeId} · 对等节点: ${config.clusterPeers.map(p => p.nodeId).join(', ')}`);
} else {
  // ==================== 独立模式路由（无集群） ====================

  app.post('/api/login', loginLimiter, loginHandler);
  app.get('/api/files', requireAuth, filesListHandler);
  app.get('/api/download/:filename', requireAuth, downloadHandler);
  app.get('/api/preview/:filename', requireAuth, previewHandler);
  app.get('/api/check', checkHandler);
}

// ==================== 通用路由（独立/集群模式共用） ====================

app.post('/api/logout', logoutHandler);

app.post('/api/upload', requireAdmin, csrfCheck, uploadHandler);

app.delete('/api/files/:filename', requireAdmin, csrfCheck, deleteHandler);

app.post('/api/files/delete-batch', requireAdmin, csrfCheck, batchDeleteHandler);

app.post('/api/files/:filename/rekey', requireAdmin, csrfCheck, rekeyHandler);

app.get('/api/disk', requireAdmin, diskHandler);

app.get('/api/health', healthHandler);

// 文本片段
app.post('/api/snippets', requireAdmin, csrfCheck, createSnippetHandler);
app.get('/api/snippets/:key', getSnippetHandler);

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// Multer 错误处理
app.use(handleMulterError);

// ==================== SPA Fallback ====================

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API 不存在' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 启动 ====================

app.listen(config.PORT, () => {
  console.log('');
  console.log('\u{1F4C1}  文件中转站 v2.1.0 已启动');
  console.log(`   地址: http://127.0.0.1:${config.PORT}`);
  console.log(`   管理员密钥: ${config.ADMIN_KEY}`);
  console.log(`   存储目录: ${config.UPLOAD_DIR}`);
  if (config.clusterEnabled) {
    console.log(`   集群节点: ${config.clusterNodeId}${config.clusterNodeName ? ' (' + config.clusterNodeName + ')' : ''}`);
    console.log(`   对等节点: ${config.clusterPeers.map(p => `${p.nodeId} (${p.endpoint})`).join(', ')}`);
  } else {
    console.log('   模式: 独立运行');
  }
  console.log('');
});
