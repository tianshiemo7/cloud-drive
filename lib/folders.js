// ==================== 文件夹管理模块 ====================
// 虚拟文件夹 — 不改变磁盘上文件的实际位置

const path = require('path');
const fs = require('fs');
const config = require('./config');
const { loadFolders, saveFolders } = require('./persistence');
const { loadKeys, saveKeys } = require('./persistence');
const { requireAdmin, csrfCheck } = require('./auth');

// ===== 工具 =====

function buildTree(folders, nodeId) {
  const tree = [];
  const folderMap = {};

  // 按 nodeId 过滤
  const nodeFolders = {};
  for (const [id, f] of Object.entries(folders)) {
    if (!nodeId || f.nodeId === nodeId) {
      nodeFolders[id] = f;
    }
  }

  // 构建映射
  for (const [id, f] of Object.entries(nodeFolders)) {
    folderMap[id] = { id, name: f.name, nodeId: f.nodeId, parent: f.parent, children: [] };
  }

  // 建立父子关系
  for (const [id, folder] of Object.entries(folderMap)) {
    if (folder.parent && folderMap[folder.parent]) {
      folderMap[folder.parent].children.push(folder);
    } else if (!folder.parent) {
      tree.push(folder);
    }
  }

  // 排序
  const sortFn = (a, b) => a.name.localeCompare(b.name);
  tree.sort(sortFn);
  for (const folder of Object.values(folderMap)) {
    folder.children.sort(sortFn);
  }

  return tree;
}

// 生成文件夹 ID（路径形式）
function makeFolderId(name, parent) {
  const safe = name.replace(/[\/\\]/g, '_').replace(/\s+/g, '_').toLowerCase();
  return parent ? `${parent}/${safe}` : safe;
}

// ===== 路由处理函数 =====

function listFoldersHandler(req, res) {
  const folders = loadFolders();
  const tree = buildTree(folders, null); // 所有节点

  // 按 nodeId 分组
  const grouped = {};
  for (const [id, f] of Object.entries(folders)) {
    if (!grouped[f.nodeId]) grouped[f.nodeId] = [];
    grouped[f.nodeId].push({ id, ...f });
  }

  res.json({ folders: tree, grouped });
}

function createFolderHandler(req, res) {
  const { name, parent, nodeId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '文件夹名称不能为空' });

  const folders = loadFolders();
  const folderId = makeFolderId(name.trim(), parent || null);

  if (folders[folderId]) return res.status(409).json({ error: '该文件夹已存在' });

  folders[folderId] = {
    name: name.trim(),
    parent: parent || null,
    nodeId: nodeId || config.clusterNodeId || 'local',
    createdAt: new Date().toISOString()
  };

  saveFolders(folders);
  res.json({ success: true, id: folderId, ...folders[folderId] });
}

function deleteFolderHandler(req, res) {
  const folderId = decodeURIComponent(req.params.id);
  const folders = loadFolders();

  if (!folders[folderId]) return res.status(404).json({ error: '文件夹不存在' });

  // 检查是否有子文件夹
  const hasChildren = Object.values(folders).some(f => f.parent === folderId);
  if (hasChildren) return res.status(400).json({ error: '请先删除子文件夹' });

  // 将该文件夹下的文件移回根目录
  const keys = loadKeys();
  let keysChanged = false;
  for (const [filename, meta] of Object.entries(keys)) {
    const m = typeof meta === 'string' ? { key: meta } : meta;
    if (m.folder === folderId) {
      if (typeof keys[filename] === 'string') {
        keys[filename] = { key: keys[filename], folder: null };
      } else {
        keys[filename].folder = null;
      }
      keysChanged = true;
    }
  }
  if (keysChanged) saveKeys(keys);

  delete folders[folderId];
  saveFolders(folders);
  res.json({ success: true });
}

function moveFileHandler(req, res) {
  const filename = decodeURIComponent(req.params.name);
  const { folder } = req.body; // null = 移到根目录, string = 文件夹ID

  const keys = loadKeys();
  const meta = keys[filename];
  if (!meta) return res.status(404).json({ error: '文件不存在' });

  // 如果指定了文件夹，检查其是否存在
  if (folder !== null && folder !== undefined && folder !== '') {
    const folders = loadFolders();
    if (!folders[folder]) return res.status(404).json({ error: '目标文件夹不存在' });
  }

  const targetFolder = (folder === null || folder === undefined || folder === '') ? null : folder;

  if (typeof keys[filename] === 'string') {
    keys[filename] = { key: keys[filename], folder: targetFolder };
  } else {
    keys[filename].folder = targetFolder;
  }

  saveKeys(keys);
  res.json({ success: true, filename, folder: targetFolder });
}

function renameFolderHandler(req, res) {
  const folderId = decodeURIComponent(req.params.id);
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名称不能为空' });

  const folders = loadFolders();
  if (!folders[folderId]) return res.status(404).json({ error: '文件夹不存在' });

  const oldFolder = folders[folderId];
  const parent = oldFolder.parent;

  // 生成新 ID
  const newId = makeFolderId(name.trim(), parent);
  if (newId !== folderId && folders[newId]) {
    return res.status(409).json({ error: '同名文件夹已存在' });
  }

  // 更新文件夹
  oldFolder.name = name.trim();
  delete folders[folderId];
  folders[newId] = oldFolder;

  // 更新子文件夹的 parent 引用
  for (const [id, f] of Object.entries(folders)) {
    if (f.parent === folderId) {
      f.parent = newId;
    }
  }

  // 更新属于该文件夹的文件引用
  const keys = loadKeys();
  let keysChanged = false;
  for (const [filename, meta] of Object.entries(keys)) {
    const m = typeof meta === 'string' ? { key: meta } : meta;
    if (m.folder === folderId) {
      if (typeof keys[filename] === 'string') {
        keys[filename] = { key: keys[filename], folder: newId };
      } else {
        keys[filename].folder = newId;
      }
      keysChanged = true;
    }
  }
  if (keysChanged) saveKeys(keys);

  saveFolders(folders);
  res.json({ success: true, id: newId, name: name.trim() });
}

module.exports = {
  buildTree,
  listFoldersHandler,
  createFolderHandler,
  deleteFolderHandler,
  moveFileHandler,
  renameFolderHandler
};
