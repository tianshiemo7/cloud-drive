// ==================== 文件管理模块 ====================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { safePath, isPreviewable, md5File, generateFileKey, upload, handleMulterError } = require('./utils');
const { loadKeys, saveKeys, loadFolders } = require('./persistence');
const { requireAuth, requireAdmin, csrfCheck } = require('./auth');

// ===== 上传辅助 =====

async function processUploadedFiles(files, req, res) {
  const keys = loadKeys();
  const results = [];

  // 确定目标文件夹：优先使用前端传来的 folder 参数，否则用当前节点根文件夹
  let targetFolder = null;
  if (req.body.folder) {
    const folders = loadFolders();
    if (Object.hasOwn(folders, req.body.folder)) {
      targetFolder = req.body.folder;
    }
  }
  if (!targetFolder) {
    targetFolder = config.clusterNodeId || 'local';
  }

  for (const file of files) {
    // v3.0: 基于文件内容 SHA-256 生成全局唯一密钥
    const fileKey = await generateFileKey(file.path);
    const md5 = await md5File(file.path);

    keys[file.filename] = {
      key: fileKey,
      folder: targetFolder,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      oneTime: false,
      downloadCount: 0,
      maxDownloads: null,
      md5
    };

    results.push({
      name: file.filename,
      size: file.size,
      key: fileKey,
      md5
    });
  }

  saveKeys(keys);
  res.json({ success: true, files: results });
}

// ===== 路由处理函数 =====

function filesListHandler(req, res) {
  if (req.session.role === 'viewer') {
    const filename = req.session.filename;
    const filePath = path.join(config.UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) return res.json({ files: [] });
    const stats = fs.statSync(filePath);
    return res.json({ files: [{ name: filename, size: stats.size, modified: stats.mtime.toISOString() }] });
  }

  // admin: 读取本地文件
  fs.readdir(config.UPLOAD_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: '读取文件列表失败' });
    const keys = loadKeys();
    const fileList = files
      .filter(n => !n.startsWith('.'))
      .map(name => {
        const filePath = path.join(config.UPLOAD_DIR, name);
        try {
          const stats = fs.statSync(filePath);
          const meta = keys[name];
          const m = typeof meta === 'string' ? { key: meta } : (meta || {});
          return {
            name,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            key: m.key || null,
            expiresAt: m.expiresAt || null,
            oneTime: !!m.oneTime,
            downloadCount: m.downloadCount || 0,
            maxDownloads: m.maxDownloads || null,
            md5: m.md5 || null,
            preview: isPreviewable(name),
            folder: m.folder || null,
            nodeId: config.clusterNodeId || 'local'
          };
        } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.modified.localeCompare(a.modified));

    // 如果启用了集群，由外部增强来合并远程文件
    if (req._aggregateRemoteFiles) {
      return req._aggregateRemoteFiles(fileList, res);
    }

    res.json({ files: fileList });
  });
}

function uploadHandler(req, res, next) {
  upload.array('files', 20)(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    if (!req.files || req.files.length === 0) {
      upload.single('file')(req, res, (err2) => {
        if (err2) return handleMulterError(err2, req, res, next);
        if (!req.file) return res.status(400).json({ error: '没有文件' });
        processUploadedFiles([req.file], req, res);
      });
      return;
    }
    processUploadedFiles(req.files, req, res);
  });
}

function downloadHandler(req, res) {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = safePath(config.UPLOAD_DIR, filename);
  if (!filePath) return res.status(403).json({ error: '禁止访问' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

  if (req.session.role === 'viewer' && filename !== req.session.filename) {
    return res.status(403).json({ error: '无权下载此文件' });
  }

  const keys = loadKeys();
  const meta = keys[filename];
  const m = typeof meta === 'string' ? { key: meta } : (meta || {});

  if (m.expiresAt && Date.now() > new Date(m.expiresAt).getTime()) {
    return res.status(410).json({ error: '文件已过期' });
  }

  if (m.maxDownloads && m.downloadCount >= m.maxDownloads) {
    return res.status(410).json({ error: '下载次数已用完' });
  }

  if (keys[filename]) {
    if (typeof keys[filename] === 'string') {
      keys[filename] = { key: keys[filename], downloadCount: 1 };
    } else {
      keys[filename].downloadCount = (keys[filename].downloadCount || 0) + 1;
    }
    saveKeys(keys);
  }

  if (m.oneTime) {
    res.download(filePath, filename, (err) => {
      if (!err) {
        try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        delete keys[filename];
        saveKeys(keys);
        console.log(`\u{1F525} 阅后即焚: ${filename}`);
      }
    });
    return;
  }

  res.download(filePath, filename);
}

function deleteHandler(req, res) {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = safePath(config.UPLOAD_DIR, filename);
  if (!filePath) return res.status(403).json({ error: '禁止访问' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

  fs.unlink(filePath, (err) => {
    if (err) return res.status(500).json({ error: '删除失败' });
    const keys = loadKeys();
    delete keys[filename];
    saveKeys(keys);
    res.json({ success: true });
  });
}

function batchDeleteHandler(req, res) {
  const { filenames } = req.body;
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({ error: '请提供要删除的文件列表' });
  }

  const keys = loadKeys();
  const results = { deleted: [], failed: [] };

  for (const filename of filenames) {
    const filePath = safePath(config.UPLOAD_DIR, filename);
    if (!filePath || !fs.existsSync(filePath)) {
      results.failed.push(filename);
      continue;
    }
    try {
      fs.unlinkSync(filePath);
      delete keys[filename];
      results.deleted.push(filename);
    } catch (e) {
      results.failed.push(filename);
    }
  }

  saveKeys(keys);
  res.json({ success: true, ...results });
}

async function rekeyHandler(req, res) {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = safePath(config.UPLOAD_DIR, filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

  const { expiresIn, oneTime, maxDownloads } = req.body;
  const keys = loadKeys();

  // v3.0: 密钥基于内容哈希，不变；仅更新有效期/阅后即焚/下载限制等设置
  let newKey;
  try {
    newKey = await generateFileKey(filePath);
  } catch (e) {
    newKey = (typeof keys[filename] === 'object' ? keys[filename].key : keys[filename]) ||
             crypto.randomBytes(6).toString('hex');
  }

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  const oldMeta = typeof keys[filename] === 'object' ? keys[filename] : {};
  keys[filename] = {
    key: newKey,
    folder: oldMeta.folder || null,
    createdAt: oldMeta.createdAt || new Date().toISOString(),
    expiresAt,
    oneTime: !!oneTime,
    downloadCount: 0,
    maxDownloads: maxDownloads || null,
    md5: oldMeta.md5 || null
  };

  saveKeys(keys);
  res.json({ success: true, key: newKey, expiresAt, oneTime: !!oneTime });
}

function previewHandler(req, res) {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = safePath(config.UPLOAD_DIR, filename);
  if (!filePath) return res.status(403).json({ error: '禁止访问' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  if (req.session.role === 'viewer' && filename !== req.session.filename) {
    return res.status(403).json({ error: '无权访问' });
  }
  res.sendFile(filePath);
}

function diskHandler(req, res) {
  let totalSize = 0, fileCount = 0;
  try {
    fs.readdirSync(config.UPLOAD_DIR).forEach(name => {
      try { totalSize += fs.statSync(path.join(config.UPLOAD_DIR, name)).size; fileCount++; } catch (e) { /* skip */ }
    });
  } catch (e) { /* ignore */ }
  res.json({ usedBytes: totalSize, fileCount });
}

function healthHandler(req, res) {
  const keys = loadKeys();
  const folders = loadFolders();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().heapUsed,
    files: Object.keys(keys).length,
    folders: Object.keys(folders).length,
    uploadDir: config.UPLOAD_DIR,
    version: '2.2.0'
  });
}

// 移动文件到文件夹
function moveFileHandler(req, res) {
  const filename = decodeURIComponent(req.params.name);
  const { folder } = req.body;

  const keys = loadKeys();
  const meta = keys[filename];
  if (!meta) return res.status(404).json({ error: '文件不存在' });

  // null / undefined / '' 表示移到节点根目录
  const isRoot = (folder === null || folder === undefined || folder === '');
  let targetFolder;

  if (isRoot) {
    targetFolder = config.clusterNodeId || 'local';
  } else {
    // 验证目标文件夹存在（使用 Object.hasOwn 避免原型链绕过）
    const folders = loadFolders();
    if (!Object.hasOwn(folders, folder)) {
      return res.status(404).json({ error: '目标文件夹不存在' });
    }
    targetFolder = folder;
  }

  if (typeof keys[filename] === 'string') {
    keys[filename] = { key: keys[filename], folder: targetFolder };
  } else {
    keys[filename].folder = targetFolder;
  }

  saveKeys(keys);
  res.json({ success: true, filename, folder: targetFolder });
}

module.exports = {
  processUploadedFiles,
  filesListHandler,
  uploadHandler,
  downloadHandler,
  deleteHandler,
  batchDeleteHandler,
  rekeyHandler,
  previewHandler,
  diskHandler,
  healthHandler,
  moveFileHandler
};
