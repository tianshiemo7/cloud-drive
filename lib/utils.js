// ==================== 工具函数 ====================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

// ===== 限速器 =====

const rateLimitMap = new Map();

function createRateLimiter(maxAttempts, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetTime) {
      rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    if (entry.count >= maxAttempts) {
      const waitMin = Math.ceil((entry.resetTime - now) / 60000);
      return res.status(429).json({ error: `尝试次数过多，请 ${waitMin} 分钟后再试` });
    }

    entry.count++;
    next();
  };
}

// 定期清理过期限速记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 60000);

const loginLimiter = createRateLimiter(10, 5 * 60 * 1000);
const uploadLimiter = createRateLimiter(30, 5 * 60 * 1000);

// ===== 文件工具 =====

function md5File(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

// v3.0: 基于文件内容 SHA-256 生成全局唯一密钥
// 同内容=同密钥，天然跨节点去重，彻底消除碰撞
function generateFileKey(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 12)));
    stream.on('error', (e) => reject(e));
  });
}

function safePath(baseDir, filename) {
  const resolved = path.resolve(path.join(baseDir, filename));
  if (!resolved.startsWith(path.resolve(baseDir))) return null;
  return resolved;
}

function isPreviewable(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const images = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'];
  const videos = ['mp4', 'webm', 'mov'];
  const audio = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
  if (images.includes(ext)) return 'image';
  if (videos.includes(ext)) return 'video';
  if (audio.includes(ext)) return 'audio';
  return null;
}

// ===== Multer 配置 =====

const storage = multer.diskStorage({
  destination: config.UPLOAD_DIR,
  filename: (req, file, cb) => {
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});

const upload = multer({ storage, limits: { fileSize: config.MAX_FILE_SIZE } });

function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件过大，最大支持 500MB' });
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  next(err);
}

module.exports = {
  createRateLimiter,
  loginLimiter,
  uploadLimiter,
  md5File,
  generateFileKey,
  safePath,
  isPreviewable,
  storage,
  upload,
  handleMulterError
};
