// ==================== 认证模块 ====================

const crypto = require('crypto');
const config = require('./config');
const { loadKeys } = require('./persistence');
const { loginLimiter } = require('./utils');

// ===== 中间件 =====

function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.session.csrf && req.headers['x-csrf-token'] === req.session.csrf) return next();
  res.status(403).json({ error: 'CSRF 校验失败，请刷新页面重试' });
}

function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: '需要管理员权限' });
}

function requireAuth(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'viewer') return next();
  res.status(401).json({ error: '未登录，请输入密钥' });
}

// ===== 路由处理函数 =====

function loginHandler(req, res) {
  const { key } = req.body;
  if (!key || !key.trim()) return res.status(400).json({ error: '请输入密钥' });

  const trimmedKey = key.trim();

  // 检查管理员密钥
  if (trimmedKey === config.ADMIN_KEY) {
    req.session.role = 'admin';
    req.session.csrf = crypto.randomBytes(16).toString('hex');
    return res.json({ success: true, role: 'admin', csrf: req.session.csrf });
  }

  // 检查文件密钥
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
      // 标记文件在本地节点
      req.session.sourceNodeId = null;
      return res.json({ success: true, role: 'viewer', filename });
    }
  }

  // 如果本地没找到，尝试跨节点查找（由外部增强）
  if (req._tryCrossNodeLookup) {
    return req._tryCrossNodeLookup(trimmedKey);
  }

  res.status(401).json({ error: '密钥无效' });
}

function logoutHandler(req, res) {
  req.session.destroy(() => res.json({ success: true }));
}

function checkHandler(req, res) {
  if (req.session.role === 'admin') {
    return res.json({ authenticated: true, role: 'admin', csrf: req.session.csrf });
  }
  if (req.session.role === 'viewer' && req.session.filename) {
    const keys = loadKeys();
    const meta = keys[req.session.filename];
    const m = typeof meta === 'string' ? { key: meta } : meta;
    if (m && m.key === req.session.fileKey) {
      return res.json({
        authenticated: true,
        role: 'viewer',
        filename: req.session.filename,
        oneTimeConsumed: m.oneTime && m.downloadCount > 0
      });
    }
    // 本地找不到，但可能来自远程节点——由外部增强处理
    if (req.session.sourceNodeId && req._checkRemoteViewer) {
      return req._checkRemoteViewer(req, res);
    }
    req.session.destroy(() => {});
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: false });
}

module.exports = {
  csrfCheck,
  requireAdmin,
  requireAuth,
  loginHandler,
  logoutHandler,
  checkHandler
};
