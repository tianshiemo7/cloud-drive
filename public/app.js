/* ==================== 基础路径 ==================== */
const BASE = (() => {
  const path = location.pathname.replace(/\/$/, '');
  return path === '' ? '' : path;
})();

/* ==================== CSRF Token ==================== */
let csrfToken = '';

/* ==================== 状态 ==================== */
let allFiles = [];
let sortKey = 'modified';
let sortAsc = false;
let selectedFiles = new Set();
let contextFile = null;

/* ==================== DOM 引用 ==================== */
const $ = (s) => document.querySelector(s);

const loginPage = $('#loginPage');
const adminPage = $('#adminPage');
const viewerPage = $('#viewerPage');

const keyInput = $('#keyInput');
const loginBtn = $('#loginBtn');
const loginError = $('#loginError');

const fileInput = $('#fileInput');
const cameraInput = $('#cameraInput');
const uploadZone = $('#uploadZone');
const progressContainer = $('#progressContainer');
const progressFill = $('#progressFill');
const progressText = $('#progressText');
const progressDetail = $('#progressDetail');
const fileList = $('#fileList');
const fileCount = $('#fileCount');
const diskInfo = $('#diskInfo');
const searchInput = $('#searchInput');
const batchActions = $('#batchActions');
const batchDeleteBtn = $('#batchDeleteBtn');
const batchCancelBtn = $('#batchCancelBtn');

const viewerFileCard = $('#viewerFileCard');

const toastEl = $('#toast');
const confirmOverlay = $('#confirmOverlay');
const confirmMsg = $('#confirmMsg');
const confirmOk = $('#confirmOk');
const confirmCancel = $('#confirmCancel');

const previewOverlay = $('#previewOverlay');
const previewTitle = $('#previewTitle');
const previewBody = $('#previewBody');
const previewClose = $('#previewClose');

const qrOverlay = $('#qrOverlay');
const qrImage = $('#qrImage');
const qrKey = $('#qrKey');
const qrClose_ = $('#qrClose');

const keySettingsOverlay = $('#keySettingsOverlay');
const keySettingsFilename = $('#keySettingsFilename');
const keyTTL = $('#keyTTL');
const keyMaxDownloads = $('#keyMaxDownloads');
const keyOneTime = $('#keyOneTime');
const keySettingsSave = $('#keySettingsSave');
const keySettingsCancel = $('#keySettingsCancel');
const keySettingsResult = $('#keySettingsResult');
let keySettingsTargetFile = null;

const contextMenu = $('#contextMenu');
const snippetToggle = $('#snippetToggle');
const snippetEditor = $('#snippetEditor');
const snippetText = $('#snippetText');
const snippetSaveBtn = $('#snippetSaveBtn');
const snippetCancelBtn = $('#snippetCancelBtn');

let confirmCallback = null;

/* ==================== 工具函数 ==================== */

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = {
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', bmp: '🖼', svg: '🖼', webp: '🖼', heic: '🖼',
    mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', wmv: '🎬', flv: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', m4a: '🎵',
    pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📑', pptx: '📑',
    txt: '📃', md: '📃', csv: '📊',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦', bz2: '📦',
    js: '💻', ts: '💻', py: '💻', java: '💻', cpp: '💻', c: '💻', html: '💻', css: '💻', json: '💻',
    exe: '⚙', dmg: '⚙', apk: '📱', iso: '💿',
  };
  return map[ext] || '📎';
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timeout);
  toastEl._timeout = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function showConfirm(msg, cb) {
  confirmMsg.textContent = msg;
  confirmCallback = cb;
  confirmOverlay.style.display = 'flex';
}

function hideConfirm() {
  confirmOverlay.style.display = 'none';
  confirmCallback = null;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/* ==================== API ==================== */

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (csrfToken) opts.headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function apiUpload(url, formData, onProgress, onFileDone) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || '上传失败'));
      } catch (e) { reject(new Error('解析响应失败')); }
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误')));
    xhr.addEventListener('abort', () => reject(new Error('上传取消')));
    xhr.send(formData);
  });
}

/* ==================== 认证 ==================== */

async function checkAuth() {
  try {
    const data = await api('GET', `${BASE}/api/check`);
    if (data.csrf) csrfToken = data.csrf;
    if (data.authenticated) showPage(data.role, data.filename);
    else showPage('login');
  } catch (e) { showPage('login'); }
}

function showPage(role, filename) {
  loginPage.style.display = 'none';
  adminPage.style.display = 'none';
  viewerPage.style.display = 'none';

  if (role === 'admin') {
    adminPage.style.display = 'flex';
    loadFiles();
    loadDiskInfo();
  } else if (role === 'viewer') {
    viewerPage.style.display = 'flex';
    loadViewerFile(filename);
  } else {
    loginPage.style.display = 'flex';
    const urlKey = new URLSearchParams(location.search).get('key');
    if (urlKey) { keyInput.value = urlKey; doLogin(urlKey); }
  }
}

async function doLogin(key) {
  key = key || keyInput.value;
  loginBtn.disabled = true;
  loginError.textContent = '';

  try {
    const data = await api('POST', `${BASE}/api/login`, { key });
    if (data.csrf) csrfToken = data.csrf;
    if (location.search) history.replaceState({}, '', location.pathname);
    showPage(data.role, data.filename);
  } catch (e) {
    loginError.textContent = e.message;
    keyInput.focus();
    keyInput.select();
  } finally { loginBtn.disabled = false; }
}

async function doLogout() {
  try { await api('POST', `${BASE}/api/logout`); } catch (e) { /* ignore */ }
  csrfToken = '';
  keyInput.value = '';
  showPage('login');
}

/* ==================== 文件列表与排序/搜索 ==================== */

async function loadFiles() {
  try {
    const data = await api('GET', `${BASE}/api/files`);
    allFiles = data.files;
    renderFilteredFiles();
    fileCount.textContent = `(${allFiles.length})`;
    // 更新节点健康状态
    if (data.nodes) {
      updateNodeStatus(data.nodes);
    }
  } catch (e) { toast('加载文件列表失败: ' + e.message); }
}

let nodeFilter = 'all';
let clusterNodes = [];

function updateNodeStatus(nodes) {
  clusterNodes = nodes;
  const up = nodes.filter(n => !n.error).length;
  const total = nodes.length;
  // 更新节点过滤下拉
  let nodeFilterEl = $('#nodeFilter');
  if (!nodeFilterEl && nodes.length > 1) {
    // 动态创建节点过滤下拉
    const sortBar = document.querySelector('.sort-bar');
    if (sortBar) {
      nodeFilterEl = document.createElement('select');
      nodeFilterEl.id = 'nodeFilter';
      nodeFilterEl.style.cssText = 'margin-left:8px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;cursor:pointer;';
      nodeFilterEl.addEventListener('change', () => {
        nodeFilter = nodeFilterEl.value;
        renderFilteredFiles();
      });
      sortBar.appendChild(nodeFilterEl);
    }
  }
  if (nodeFilterEl) {
    nodeFilterEl.innerHTML = `<option value="all">全部节点 (${total})</option>` +
      nodes.map(n => `<option value="${escapeHtml(n.nodeId)}" ${n.error ? 'disabled' : ''}>${escapeHtml(n.nodeId)}${n.error ? ' ⚠离线' : ' ✅'} (${n.fileCount || 0})</option>`).join('');
  }
  // 在磁盘信息区追加节点状态
  if ($('#diskInfo') && nodes.length > 1) {
    const diskInfo = $('#diskInfo');
    const existingStatus = $('#nodeStatusText');
    if (existingStatus) existingStatus.remove();
    const span = document.createElement('span');
    span.id = 'nodeStatusText';
    span.style.cssText = 'margin-left:8px;';
    span.textContent = `🖥 ${up}/${total} 节点在线`;
    diskInfo.appendChild(span);
  }
}

async function loadDiskInfo() {
  try {
    const data = await api('GET', `${BASE}/api/disk`);
    diskInfo.textContent = `💾 ${formatSize(data.usedBytes)} · ${data.fileCount} 个文件`;
  } catch (e) { diskInfo.textContent = ''; }
}

function getSortedFiles() {
  const sorted = [...allFiles];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortKey === 'size') cmp = a.size - b.size;
    else cmp = new Date(a.modified) - new Date(b.modified);
    return sortAsc ? cmp : -cmp;
  });
  return sorted;
}

function renderFilteredFiles() {
  const query = (searchInput.value || '').toLowerCase();
  const sorted = getSortedFiles();
  let filtered = query ? sorted.filter(f => f.name.toLowerCase().includes(query)) : sorted;
  // 按节点过滤
  if (nodeFilter !== 'all') {
    filtered = filtered.filter(f => f.nodeId === nodeFilter);
  }

  if (filtered.length === 0) {
    fileList.innerHTML = `<div class="empty-state">${query ? '没有匹配的文件' : '暂无文件，上传第一个吧 📤'}</div>`;
  } else {
    fileList.innerHTML = filtered.map(f => renderFileItem(f)).join('');
  }

  fileCount.textContent = `(${filtered.length}${filtered.length !== allFiles.length ? '/' + allFiles.length : ''})`;
  selectedFiles.clear();
  updateBatchUI();
}

function renderFileItem(f) {
  const badges = [];
  if (f.oneTime) badges.push('<span class="file-badge onetime">阅后即焚</span>');
  if (f.expiresAt) badges.push(`<span class="file-badge expiring">过期: ${formatDate(f.expiresAt)}</span>`);
  if (f.maxDownloads && f.downloadCount >= f.maxDownloads) badges.push('<span class="file-badge limited">已用完</span>');
  else if (f.maxDownloads) badges.push(`<span class="file-badge limited">${f.downloadCount}/${f.maxDownloads}次</span>`);

  const previewBtn = f.preview ? `<button class="btn btn-ghost-small" onclick="previewFile('${escapeAttr(f.name)}','${f.preview}')" title="预览">👁</button>` : '';

  return `
    <div class="file-item" data-filename="${escapeHtml(f.name)}" oncontextmenu="showContextMenu(event,'${escapeAttr(f.name)}')">
      <input type="checkbox" class="file-checkbox" onchange="toggleSelect('${escapeAttr(f.name)}',this.checked)" ${selectedFiles.has(f.name) ? 'checked' : ''}>
      <div class="file-icon" ondblclick="${f.preview ? `previewFile('${escapeAttr(f.name)}','${f.preview}')` : `downloadFile('${escapeAttr(f.name)}')`}">${fileIcon(f.name)}</div>
      <div class="file-info">
        <div class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="file-meta">
          <span>${formatSize(f.size)}</span>
          <span>${formatDate(f.modified)}</span>
          ${f.md5 ? `<span title="MD5: ${f.md5}">🔒</span>` : ''}
          ${f.nodeId ? `<span class="node-tag" title="存储节点">🖥 ${escapeHtml(f.nodeId)}</span>` : ''}
        </div>
        ${badges.length ? `<div class="file-badges">${badges.join('')}</div>` : ''}
        ${f.key ? `
        <div class="file-key-area">
          <span class="file-key-value">🔑 ${escapeHtml(f.key)}</span>
          <button class="btn btn-sm" onclick="copyKey('${escapeAttr(f.key)}')">📋</button>
          <button class="btn btn-sm" onclick="copyShareLink('${escapeAttr(f.key)}')">🔗</button>
          <button class="btn btn-sm" onclick="showQR('${escapeAttr(f.key)}')">📱</button>
          <button class="btn btn-sm" onclick="showKeySettings('${escapeAttr(f.name)}')">⚙</button>
        </div>
        ` : ''}
      </div>
      <div class="file-actions">
        ${previewBtn}
        <button class="btn btn-primary btn-small" onclick="downloadFile('${escapeAttr(f.name)}')">⬇</button>
        <button class="btn btn-danger btn-small" onclick="deleteFile('${escapeAttr(f.name)}')">🗑</button>
      </div>
    </div>`;
}

/* ==================== 排序 ==================== */

document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const s = btn.dataset.sort;
    if (sortKey === s) sortAsc = !sortAsc;
    else { sortKey = s; sortAsc = false; }
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderFilteredFiles();
  });
});

/* ==================== 搜索 ==================== */

searchInput.addEventListener('input', renderFilteredFiles);

/* ==================== 多选与批量操作 ==================== */

function toggleSelect(filename, checked) {
  if (checked) selectedFiles.add(filename);
  else selectedFiles.delete(filename);
  updateBatchUI();
}

function updateBatchUI() {
  if (selectedFiles.size > 0) {
    batchActions.style.display = 'flex';
  } else {
    batchActions.style.display = 'none';
  }

  document.querySelectorAll('.file-item').forEach(el => {
    const fn = el.dataset.filename;
    el.classList.toggle('selected', selectedFiles.has(fn));
  });
}

batchDeleteBtn.addEventListener('click', () => {
  if (selectedFiles.size === 0) return;
  showConfirm(`确定要删除选中的 ${selectedFiles.size} 个文件吗？`, async () => {
    try {
      const result = await api('POST', `${BASE}/api/files/delete-batch`, {
        filenames: [...selectedFiles]
      });
      toast(`✅ 已删除 ${result.deleted.length} 个文件`);
      if (result.failed.length > 0) toast(`⚠ ${result.failed.length} 个删除失败`);
      selectedFiles.clear();
      updateBatchUI();
      loadFiles();
      loadDiskInfo();
    } catch (e) { toast('删除失败: ' + e.message); }
    hideConfirm();
  });
});

batchCancelBtn.addEventListener('click', () => {
  selectedFiles.clear();
  updateBatchUI();
});

/* ==================== 右键菜单 ==================== */

function showContextMenu(e, filename) {
  e.preventDefault();
  contextFile = filename;
  contextMenu.style.display = 'block';
  contextMenu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  contextMenu.style.top = Math.min(e.clientY, window.innerHeight - 260) + 'px';
}

document.addEventListener('click', () => { contextMenu.style.display = 'none'; });
contextMenu.addEventListener('click', (e) => {
  const action = e.target.closest('.context-item')?.dataset.action;
  if (!action || !contextFile) return;
  contextMenu.style.display = 'none';
  switch (action) {
    case 'download': downloadFile(contextFile); break;
    case 'copyKey': {
      const f = allFiles.find(x => x.name === contextFile);
      if (f?.key) copyKey(f.key);
      break;
    }
    case 'copyLink': {
      const f = allFiles.find(x => x.name === contextFile);
      if (f?.key) copyShareLink(f.key);
      break;
    }
    case 'qrCode': {
      const f = allFiles.find(x => x.name === contextFile);
      if (f?.key) showQR(f.key);
      break;
    }
    case 'keySettings': showKeySettings(contextFile); break;
    case 'delete': deleteFile(contextFile); break;
  }
  contextFile = null;
});

/* ==================== 上传 ==================== */

uploadZone.addEventListener('click', () => fileInput.click());
$('#cameraBtn').addEventListener('click', () => cameraInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    doUploadMultiple(fileInput.files);
    fileInput.value = '';
  }
});

cameraInput.addEventListener('change', () => {
  if (cameraInput.files.length > 0) {
    doUploadMultiple(cameraInput.files);
    cameraInput.value = '';
  }
});

// 剪贴板图片粘贴
document.addEventListener('paste', (e) => {
  // 登录页：粘贴密钥文本
  if (loginPage.style.display !== 'none') {
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (text && text.length <= 20) {
      keyInput.value = text;
      setTimeout(() => doLogin(text), 100);
    }
    return;
  }

  // 管理页：粘贴图片上传
  if (adminPage.style.display === 'none') return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length > 0) {
    e.preventDefault();
    doUploadMultiple(imageFiles);
    toast(`📋 已粘贴 ${imageFiles.length} 张图片`);
  }
});

// 拖拽上传
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) doUploadMultiple(e.dataTransfer.files);
});

async function doUploadMultiple(files) {
  progressContainer.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '准备上传...';
  progressDetail.textContent = `${files.length} 个文件`;

  let totalSize = 0;
  for (const f of files) totalSize += f.size;

  const formData = new FormData();
  for (const f of files) formData.append('files', f);

  try {
    const data = await apiUpload(`${BASE}/api/upload`, formData,
      (loaded, total) => {
        const pct = Math.round((loaded / total) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent = pct + '%  ' + formatSize(loaded) + ' / ' + formatSize(total);
        progressDetail.textContent = `${files.length} 个文件 · 总大小 ${formatSize(totalSize)}`;
      }
    );

    toast(`✅ 上传成功: ${data.files.length} 个文件`);
    loadFiles();
    loadDiskInfo();
  } catch (e) {
    toast('❌ ' + e.message);
  } finally {
    setTimeout(() => { progressContainer.style.display = 'none'; }, 600);
  }
}

/* ==================== 预览 ==================== */

function previewFile(filename, type) {
  previewTitle.textContent = filename;
  const url = `${BASE}/api/preview/${encodeURIComponent(filename)}`;

  if (type === 'image') {
    previewBody.innerHTML = `<img src="${url}" alt="${escapeHtml(filename)}">`;
  } else if (type === 'video') {
    previewBody.innerHTML = `<video src="${url}" controls autoplay></video>`;
  } else if (type === 'audio') {
    previewBody.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
  } else {
    previewBody.innerHTML = `<div class="preview-unsupported">此文件类型不支持预览</div>`;
  }

  previewOverlay.style.display = 'flex';
}

previewClose.addEventListener('click', () => {
  previewBody.innerHTML = '';
  previewOverlay.style.display = 'none';
});

previewOverlay.addEventListener('click', (e) => {
  if (e.target === previewOverlay) {
    previewBody.innerHTML = '';
    previewOverlay.style.display = 'none';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewOverlay.style.display !== 'none') {
    previewBody.innerHTML = '';
    previewOverlay.style.display = 'none';
  }
});

/* ==================== 下载 / 删除 / 复制 ==================== */

function downloadFile(filename) {
  const a = document.createElement('a');
  a.href = `${BASE}/api/download/${encodeURIComponent(filename)}`;
  a.click();
}

async function deleteFile(filename) {
  showConfirm(`确定要删除「${filename}」吗？`, async () => {
    try {
      await api('DELETE', `${BASE}/api/files/${encodeURIComponent(filename)}`);
      toast('已删除: ' + filename);
      loadFiles();
      loadDiskInfo();
    } catch (e) { toast('删除失败: ' + e.message); }
    hideConfirm();
  });
}

function copyToClipboard(text) {
  // 优先用 Clipboard API（需要 HTTPS）
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // HTTP 降级：传统 execCommand 方式
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(ta);
      resolve();
    } catch (e) {
      document.body.removeChild(ta);
      reject(e);
    }
  });
}

function copyKey(key) {
  copyToClipboard(key).then(
    () => toast('密钥已复制: ' + key),
    () => toast('复制失败，请手动复制')
  );
}

function copyShareLink(key) {
  const link = location.origin + location.pathname + '?key=' + key;
  copyToClipboard(link).then(
    () => toast('分享链接已复制 📋'),
    () => toast('复制失败')
  );
}

/* ==================== 二维码 ==================== */

function showQR(key) {
  const link = location.origin + location.pathname + '?key=' + key;
  qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(link)}`;
  qrKey.textContent = '密钥: ' + key;
  qrOverlay.style.display = 'flex';
}

qrClose_.addEventListener('click', () => { qrOverlay.style.display = 'none'; });
qrOverlay.addEventListener('click', (e) => { if (e.target === qrOverlay) qrOverlay.style.display = 'none'; });

/* ==================== 密钥设置 ==================== */

function showKeySettings(filename) {
  keySettingsTargetFile = filename;
  keySettingsFilename.textContent = filename;
  keyTTL.value = '0';
  keyMaxDownloads.value = '0';
  keyOneTime.checked = false;
  keySettingsResult.style.display = 'none';
  keySettingsOverlay.style.display = 'flex';
}

keySettingsSave.addEventListener('click', async () => {
  if (!keySettingsTargetFile) return;
  const ttl = parseInt(keyTTL.value);
  const maxDl = parseInt(keyMaxDownloads.value);
  const oneTime = keyOneTime.checked;

  try {
    const data = await api('POST', `${BASE}/api/files/${encodeURIComponent(keySettingsTargetFile)}/rekey`, {
      expiresIn: ttl || null,
      maxDownloads: maxDl || null,
      oneTime
    });
    $('#newKeyValue').textContent = data.key;
    keySettingsResult.style.display = 'block';
    toast('🔑 密钥已更新');
    loadFiles();
  } catch (e) { toast('设置失败: ' + e.message); }
});

keySettingsCancel.addEventListener('click', () => { keySettingsOverlay.style.display = 'none'; });
keySettingsOverlay.addEventListener('click', (e) => {
  if (e.target === keySettingsOverlay) keySettingsOverlay.style.display = 'none';
});

/* ==================== 文本片段 ==================== */

snippetToggle.addEventListener('click', () => {
  snippetEditor.style.display = snippetEditor.style.display === 'none' ? 'block' : 'none';
  if (snippetEditor.style.display === 'block') snippetText.focus();
});

snippetCancelBtn.addEventListener('click', () => {
  snippetEditor.style.display = 'none';
  snippetText.value = '';
});

snippetSaveBtn.addEventListener('click', async () => {
  const content = snippetText.value.trim();
  if (!content) return toast('请输入文本内容');

  try {
    const data = await api('POST', `${BASE}/api/snippets`, { content });
    const link = `${location.origin}${location.pathname}?snippet=${data.key}`;
    await copyToClipboard(link);
    toast('✅ 片段链接已复制到剪贴板！');
    snippetEditor.style.display = 'none';
    snippetText.value = '';
  } catch (e) { toast('创建失败: ' + e.message); }
});

// 检查 URL 是否为文本片段
(async () => {
  const snippetKey = new URLSearchParams(location.search).get('snippet');
  if (snippetKey) {
    try {
      const data = await api('GET', `${BASE}/api/snippets/${snippetKey}`);
      // 在登录页展示片段
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;';
      el.innerHTML = `<div style="background:var(--surface);border-radius:12px;padding:28px;max-width:500px;width:100%;box-shadow:var(--shadow-lg);">
        <h3 style="margin-bottom:16px">📝 文本片段</h3>
        <pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14px;line-height:1.6;margin-bottom:16px;color:var(--text);">${escapeHtml(data.content)}</pre>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">创建于 ${formatDate(data.createdAt)}</p>
        <button class="btn btn-primary" onclick="this.closest('div').parentElement.remove()" style="width:100%">关闭</button>
      </div>`;
      document.body.appendChild(el);
      history.replaceState({}, '', location.pathname);
    } catch (e) { /* ignore */ }
  }
})();

/* ==================== 暗色模式切换 ==================== */

const themeToggle = $('#globalThemeToggle');
const savedTheme = localStorage.getItem('cloud-drive-theme');

if (savedTheme === 'light') document.body.classList.add('light-mode');
else if (savedTheme === 'dark') document.body.classList.add('dark-mode');

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    if (document.body.classList.contains('light-mode')) {
      document.body.classList.remove('light-mode');
      document.body.classList.add('dark-mode');
      localStorage.setItem('cloud-drive-theme', 'dark');
    } else if (document.body.classList.contains('dark-mode')) {
      document.body.classList.remove('dark-mode');
      localStorage.setItem('cloud-drive-theme', 'light');
    } else {
      // 自动模式 → 强制暗色
      document.body.classList.add('dark-mode');
      localStorage.setItem('cloud-drive-theme', 'dark');
    }
  });

  // 监听系统主题变化（自动模式下跟随系统）
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('cloud-drive-theme')) {
      document.body.classList.toggle('dark-mode', e.matches);
    }
  });
}

/* ==================== 确认弹窗 ==================== */

confirmCancel.addEventListener('click', hideConfirm);
confirmOk.addEventListener('click', () => { if (confirmCallback) confirmCallback(); });
confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) hideConfirm(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideConfirm(); });

/* ==================== PWA ==================== */

if ('serviceWorker' in navigator) {
  // 极简 SW——仅用于缓存和离线提示
  navigator.serviceWorker.register(`${BASE}/sw.js`).catch(() => {});
}

/* ==================== 事件绑定 ==================== */

loginBtn.addEventListener('click', () => doLogin());
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#adminLogoutBtn').addEventListener('click', doLogout);
$('#viewerLogoutBtn').addEventListener('click', doLogout);

/* ==================== 访问者功能 ==================== */

async function loadViewerFile(filename) {
  try {
    const data = await api('GET', `${BASE}/api/files`);
    if (data.files.length === 0) {
      viewerFileCard.innerHTML = `
        <div class="file-icon">❓</div>
        <div class="file-name">文件不存在或已被删除</div>
        <div class="file-meta">请联系管理员重新获取密钥</div>`;
      return;
    }
    const f = data.files[0];
    viewerFileCard.innerHTML = `
      <div class="file-icon">${fileIcon(f.name)}</div>
      <div class="file-name">${escapeHtml(f.name)}</div>
      <div class="file-meta">
        <span>${formatSize(f.size)}</span>
        <span>${formatDate(f.modified)}</span>
      </div>
      <button class="btn btn-primary" onclick="downloadFile('${escapeAttr(f.name)}')">⬇ 下载文件</button>`;
  } catch (e) { toast('加载文件信息失败'); }
}

/* ==================== 启动 ==================== */
checkAuth();
