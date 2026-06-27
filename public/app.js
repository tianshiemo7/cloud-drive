/* ==================== v2.2.0 — 树形文件系统 + 设置面板 ==================== */

const BASE = (() => { const p = location.pathname.replace(/\/$/, ''); return p === '' ? '' : p; })();
let csrfToken = '';
let allFiles = [], sortKey = 'modified', sortAsc = false, selectedFiles = new Set(), contextFile = null;
let currentFolder = null, currentViewNodeId = null; // 当前浏览路径
let allFolders = [], foldersByNode = {}; // 文件夹数据

/* ==================== DOM 引用 ==================== */
const $ = s => document.querySelector(s);
const loginPage = $('#loginPage'), adminPage = $('#adminPage'), viewerPage = $('#viewerPage');
const keyInput = $('#keyInput'), loginBtn = $('#loginBtn'), loginError = $('#loginError');
const fileInput = $('#fileInput'), cameraInput = $('#cameraInput'), uploadZone = $('#uploadZone');
const progressContainer = $('#progressContainer'), progressFill = $('#progressFill'), progressText = $('#progressText'), progressDetail = $('#progressDetail');
const fileGrid = $('#fileGrid'), fileCount = $('#fileCount'), diskInfo = $('#diskInfo'), searchInput = $('#searchInput');
const batchActions = $('#batchActions'), batchDeleteBtn = $('#batchDeleteBtn'), batchCancelBtn = $('#batchCancelBtn');
const viewerFileCard = $('#viewerFileCard');
const toastEl = $('#toast'), confirmOverlay = $('#confirmOverlay'), confirmMsg = $('#confirmMsg'), confirmOk = $('#confirmOk'), confirmCancel = $('#confirmCancel');
const previewOverlay = $('#previewOverlay'), previewTitle = $('#previewTitle'), previewBody = $('#previewBody'), previewClose = $('#previewClose');
const qrOverlay = $('#qrOverlay'), qrImage = $('#qrImage'), qrKey = $('#qrKey'), qrClose_ = $('#qrClose');
const keySettingsOverlay = $('#keySettingsOverlay'), keySettingsFilename = $('#keySettingsFilename'), keyTTL = $('#keyTTL'), keyMaxDownloads = $('#keyMaxDownloads'), keyOneTime = $('#keyOneTime'), keySettingsSave = $('#keySettingsSave'), keySettingsCancel = $('#keySettingsCancel'), keySettingsResult = $('#keySettingsResult');
let keySettingsTargetFile = null;
const contextMenu = $('#contextMenu');
const snippetToggle = $('#snippetToggle'), snippetEditor = $('#snippetEditor'), snippetText = $('#snippetText'), snippetSaveBtn = $('#snippetSaveBtn'), snippetCancelBtn = $('#snippetCancelBtn');
let confirmCallback = null;

// 新增 DOM
const settingsDrawer = $('#settingsDrawer'), settingsCloseBtn = $('#settingsCloseBtn');
const treeToggleBtn = $('#treeToggleBtn'), treeSidebar = $('#treeSidebar'), treeView = $('#treeView');
const breadcrumb = $('#breadcrumb');
const newFolderBtn = $('#newFolderBtn');

/* ==================== 工具函数 ==================== */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'], i = Math.floor(Math.log(bytes)/Math.log(1024));
  return (bytes/Math.pow(1024,i)).toFixed(i===0?0:1)+' '+units[i];
}
function formatDate(isoStr) { const d = new Date(isoStr), pad = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function formatUptime(sec) { if (sec<60) return Math.floor(sec)+'秒'; if (sec<3600) return Math.floor(sec/60)+'分钟'; if (sec<86400) return Math.floor(sec/3600)+'小时'; return Math.floor(sec/86400)+'天'; }
function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  const map = { jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',bmp:'🖼',svg:'🖼',webp:'🖼',heic:'🖼',mp4:'🎬',avi:'🎬',mkv:'🎬',mov:'🎬',wmv:'🎬',flv:'🎬',webm:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',aac:'🎵',ogg:'🎵',m4a:'🎵',pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📑',pptx:'📑',txt:'📃',md:'📃',csv:'📊',zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',bz2:'📦',js:'💻',ts:'💻',py:'💻',java:'💻',cpp:'💻',c:'💻',html:'💻',css:'💻',json:'💻',exe:'⚙',dmg:'⚙',apk:'📱',iso:'💿' };
  return map[ext] || '📎';
}
function toast(msg) { toastEl.textContent=msg;toastEl.classList.add('show');clearTimeout(toastEl._timeout);toastEl._timeout=setTimeout(()=>toastEl.classList.remove('show'),2500); }
function showConfirm(msg,cb) { confirmMsg.textContent=msg;confirmCallback=cb;confirmOverlay.style.display='flex'; }
function hideConfirm() { confirmOverlay.style.display='none';confirmCallback=null; }
function escapeHtml(str) { const d=document.createElement('div');d.textContent=str;return d.innerHTML; }
function escapeAttr(str) { return str.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

/* ==================== API ==================== */
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  if (csrfToken) opts.headers['X-CSRF-Token']=csrfToken;
  const res = await fetch(url, opts), data = await res.json();
  if (!res.ok) throw new Error(data.error||'请求失败');
  return data;
}
function apiUpload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', url);
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.addEventListener('progress', e => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); });
    xhr.addEventListener('load', () => { try { const d=JSON.parse(xhr.responseText); xhr.status>=200&&xhr.status<300?resolve(d):reject(new Error(d.error||'上传失败')); } catch(e) { reject(new Error('解析响应失败')); } });
    xhr.addEventListener('error', () => reject(new Error('网络错误')));
    xhr.send(formData);
  });
}

/* ==================== 认证 ==================== */
async function checkAuth() {
  try { const d = await api('GET',`${BASE}/api/check`); if(d.csrf)csrfToken=d.csrf; d.authenticated?showPage(d.role,d.filename):showPage('login'); }
  catch(e) { showPage('login'); }
}
function showPage(role, filename) {
  loginPage.style.display=adminPage.style.display=viewerPage.style.display='none';
  if (role==='admin') { adminPage.style.display='flex'; loadFiles(); loadFolders(); loadDiskInfo(); loadClusterInfo(); }
  else if (role==='viewer') { viewerPage.style.display='flex'; loadViewerFile(filename); }
  else { loginPage.style.display='flex'; const k=new URLSearchParams(location.search).get('key'); if(k){keyInput.value=k;doLogin(k);} }
}
async function doLogin(key) {
  key=key||keyInput.value; loginBtn.disabled=true; loginError.textContent='';
  try { const d=await api('POST',`${BASE}/api/login`,{key}); if(d.csrf)csrfToken=d.csrf; if(location.search)history.replaceState({},'',location.pathname); showPage(d.role,d.filename); }
  catch(e) { loginError.textContent=e.message; keyInput.focus(); keyInput.select(); }
  finally { loginBtn.disabled=false; }
}
async function doLogout() { try{await api('POST',`${BASE}/api/logout`);}catch(e){} csrfToken='';keyInput.value='';showPage('login'); }

/* ==================== 集群信息 ==================== */
async function loadClusterInfo() {
  try {
    const d = await api('GET', `${BASE}/api/cluster/settings`);
    const nodeId = d.nodeId || 'local';
    document.getElementById('siNodeId').textContent = nodeId;
    document.getElementById('siNodeName').textContent = d.nodeName || nodeId;
    const epEl = document.getElementById('siEndpoint');
    if (epEl) {
      epEl.textContent = d.endpoint || 'http://' + window.location.hostname + ':' + (window.location.port || '80');
      epEl.addEventListener('click', () => copyText(epEl.textContent));
    }
    document.getElementById('siClusterMode').textContent = d.enabled ? `集群 (${d.peerCount || d.peers?.length || 0} 个对等节点)` : '独立模式';
    const syncEl = document.getElementById('siLastSync');
    if (syncEl) syncEl.textContent = d.lastSync ? new Date(d.lastSync).toLocaleTimeString() : '尚未同步';
    if (d.nodeName) { const el = $('#setNodeName'); if (el) el.value = d.nodeName; }
    // 填充分享信息
    if (d.shareText) {
      const shareEl = $('#shareInfo');
      if (shareEl) {
        shareEl.value = d.shareText;
        if (d.shareInfo) shareEl._json = d.shareInfo;
        if (d.shareToken) shareEl._token = d.shareToken;
      }
    }
    if (!d.secret && $('#shareInfo')) {
      $('#shareInfo').value = '⚠ 请先在 .env 中设置 CLUSTER_SECRET\n点击下方「生成连接口令」自动生成并部署';
    }
    await loadPeerStatus();
    await loadPeerForm(d.peers || []);

    // 自动选中当前节点的根文件夹
    if (!currentViewNodeId) {
      currentViewNodeId = nodeId;
      currentFolder = nodeId; // 默认打开节点根文件夹
      updateBreadcrumb();
      renderFileGrid();
    }

    // 版本/运行时间
    try {
      const h = await api('GET', `${BASE}/api/health`);
      const siVersion = document.getElementById('siVersion'); if (siVersion) siVersion.textContent = 'v' + (h.version || '?');
      const siUptime = document.getElementById('siUptime'); if (siUptime) siUptime.textContent = formatUptime(h.uptime || 0);
    } catch(e) { /* ignore */ }
  } catch(e) { /* ignore */ }
}
async function loadPeerStatus() {
  try {
    const d = await api('GET', `${BASE}/api/cluster/peers/status`);
    renderPeerList(d.peers || []);
  } catch(e) { /* ignore */ }
}
function renderPeerList(peers) {
  const el = $('#peerList');
  if (!peers.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">暂无对等节点</p>'; return; }
  el.innerHTML = peers.map(p => {
    const cacheInfo = p.fileCount ? ` · ${p.fileCount} 个文件` : '';
    const syncInfo = p.cachedAt ? ` · 同步于 ${new Date(p.cachedAt).toLocaleTimeString()}` : '';
    return `
    <div class="peer-item">
      <span class="peer-status ${p.online?'online':'offline'}">${p.online?'🟢':'🔴'}</span>
      <div class="peer-info">
        <strong>${escapeHtml(p.nodeName||p.nodeId)}</strong>
        <small style="cursor:pointer;color:var(--accent);" onclick="copyText('${escapeAttr(p.endpoint)}')" title="点击复制地址">📋 ${escapeHtml(p.endpoint)}</small>
        <small>${cacheInfo}${syncInfo}</small>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removePeer('${escapeAttr(p.nodeId)}')">移除</button>
    </div>
  `;}).join('');
}
function loadPeerForm(peers) {
  // Show existing peers' secrets masked
}

/* ==================== 文件列表 ==================== */
async function loadFiles() {
  try {
    const d = await api('GET', `${BASE}/api/files`);
    allFiles = d.files || [];
    renderFileGrid();  // updateFileCount 在 renderFileGrid 内已设置正确的过滤计数
    if (d.nodes) updateNodeStatus(d.nodes);
  } catch(e) { toast('加载文件列表失败: '+e.message); }
}
function updateNodeStatus(nodes) {
  const up = nodes.filter(n=>!n.error).length;
  const diskEl = $('#diskInfo');
  if (diskEl && nodes.length > 1) {
    const existing = $('#nodeStatusText'); if (existing) existing.remove();
    const span = document.createElement('span'); span.id='nodeStatusText'; span.style.marginLeft='8px'; span.textContent=`🖥 ${up}/${nodes.length} 在线`;
    diskEl.appendChild(span);
  }
}
async function loadDiskInfo() {
  try { const d=await api('GET',`${BASE}/api/disk`); diskInfo.textContent=`💾 ${formatSize(d.usedBytes)} · ${d.fileCount} 个文件`;
    document.getElementById('siDisk').textContent = formatSize(d.usedBytes);
    document.getElementById('siFileCount').textContent = d.fileCount;
  } catch(e) { diskInfo.textContent=''; }
}
function getSortedFiles() {
  const sorted = [...allFiles];
  sorted.sort((a,b)=>{ let cmp=0; if(sortKey==='name')cmp=a.name.localeCompare(b.name); else if(sortKey==='size')cmp=a.size-b.size; else cmp=new Date(a.modified)-new Date(b.modified); return sortAsc?cmp:-cmp; });
  return sorted;
}
function getFilteredFiles() {
  const query = (searchInput.value||'').toLowerCase();
  let files = getSortedFiles();
  if (query) files = files.filter(f => f.name.toLowerCase().includes(query));
  // 按当前浏览的文件夹过滤
  if (currentFolder !== null) {
    files = files.filter(f => f.folder === currentFolder);
  } else if (currentViewNodeId) {
    files = files.filter(f => (f.nodeId||'local') === currentViewNodeId && !f.folder);
  }
  // else: 初始状态不设置过滤，显示所有文件（等 loadClusterInfo 后自动聚焦根文件夹）
  return files;
}

/* ==================== 文件网格渲染 ==================== */
function renderFileGrid() {
  const filtered = getFilteredFiles();
  if (filtered.length === 0) {
    fileGrid.innerHTML = `<div class="empty-state">${searchInput.value?'没有匹配的文件':'此目录为空'}</div>`;
  } else {
    fileGrid.innerHTML = filtered.map(f => renderFileCard(f)).join('');
  }
  updateFileCount(filtered);
  selectedFiles.clear(); updateBatchUI();
}
function renderFileCard(f) {
  const badges = [];
  if (f.oneTime) badges.push('<span class="file-badge onetime">阅后即焚</span>');
  if (f.expiresAt) badges.push(`<span class="file-badge expiring">${formatDate(f.expiresAt)}</span>`);
  if (f.maxDownloads && f.downloadCount>=f.maxDownloads) badges.push('<span class="file-badge limited">已用完</span>');
  else if (f.maxDownloads) badges.push(`<span class="file-badge limited">${f.downloadCount}/${f.maxDownloads}次</span>`);

  const nodeTag = f.nodeId ? `<span class="node-tag" title="存储位置">🖥 ${escapeHtml(f.nodeId)}</span>` : '';

  // 文件夹标签：非根目录时显示所属文件夹
  const siNodeId = document.getElementById('siNodeId')?.textContent || '';
  const folderTag = (f.folder && f.folder !== siNodeId)
    ? `<span class="node-tag folder-tag" title="所属文件夹" onclick="event.stopPropagation();selectTreeNode('${escapeAttr(f.nodeId||siNodeId)}','${escapeAttr(f.folder)}')">📁 ${escapeHtml((allFolders.find(x=>x.id===f.folder)||{}).name||f.folder)}</span>`
    : '';

  return `
    <div class="file-card" draggable="true" data-filename="${escapeHtml(f.name)}" ondragstart="dragFileStart(event,'${escapeAttr(f.name)}')" ondragend="dragFileEnd(event)" oncontextmenu="showContextMenu(event,'${escapeAttr(f.name)}')">
      <input type="checkbox" class="file-checkbox" onchange="toggleSelect('${escapeAttr(f.name)}',this.checked)" onclick="event.stopPropagation()" ${selectedFiles.has(f.name)?'checked':''}>
      <div class="file-card-icon" ondblclick="downloadFile('${escapeAttr(f.name)}')" onclick="${f.preview?`previewFile('${escapeAttr(f.name)}','${f.preview}')`:''}">${fileIcon(f.name)}</div>
      <div class="file-card-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      <div class="file-card-meta">
        <span>${formatSize(f.size)}</span>
        ${folderTag}
        ${nodeTag}
      </div>
      <div class="file-card-date">${formatDate(f.modified)}</div>
      ${badges.length?`<div class="file-badges">${badges.join('')}</div>`:''}
      ${f.key?`<div class="file-key-area"><span class="file-key-value">🔑 ${escapeHtml(f.key)}</span><button class="btn btn-sm" onclick="event.stopPropagation();copyKey('${escapeAttr(f.key)}')">📋</button><button class="btn btn-sm" onclick="event.stopPropagation();copyShareLink('${escapeAttr(f.key)}')">🔗</button><button class="btn btn-sm" onclick="event.stopPropagation();showKeySettings('${escapeAttr(f.name)}')">⚙</button></div>`:''}
    </div>`;
}
function updateFileCount(filtered) {
  fileCount.textContent = `(${filtered.length}${filtered.length!==allFiles.length?'/'+allFiles.length:''})`;
}
searchInput.addEventListener('input', renderFileGrid);

/* ==================== 排序 ==================== */
document.addEventListener('click', e => {
  const btn = e.target.closest('.sort-btn');
  if (!btn) return;
  const s = btn.dataset.sort;
  if (sortKey===s) sortAsc=!sortAsc; else { sortKey=s; sortAsc=false; }
  document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderFileGrid();
});

/* ==================== 树形目录 ==================== */
async function loadFolders() {
  try {
    const d = await api('GET', `${BASE}/api/folders`);
    allFolders = d.folders || [];
    foldersByNode = d.grouped || {};
    renderTree();
  } catch(e) { /* ignore */ }
}
function renderTree() {
  // 构建树节点映射
  const nodeId = document.getElementById('siNodeId')?.textContent || '';
  const grouped = foldersByNode;

  // 如果没有集群数据，创建一个默认的本地根节点
  if (!Object.keys(grouped).length) {
    const localId = nodeId || 'local';
    grouped[localId] = [];
    // 将 allFolders 按 nodeId 分配
    allFolders.forEach(f => {
      if (!grouped[f.nodeId]) grouped[f.nodeId] = [];
      grouped[f.nodeId].push(f);
    });
  }

  let html = '';
  for (const [nid, folders] of Object.entries(grouped)) {
    const isActive = currentViewNodeId === nid && currentFolder === null;
    html += `<div class="tree-node-root ${isActive?'active':''}" data-node-id="${escapeHtml(nid)}" onclick="selectTreeNode('${escapeAttr(nid)}', '${escapeAttr(nid)}')" ondragover="folderDragOver(event,'${escapeAttr(nid)}')" ondragleave="folderDragLeave(event)" ondrop="folderDrop(event,'${escapeAttr(nid)}')">
      <span class="tree-arrow expanded">▼</span>📁 <strong>${escapeHtml(nid)}</strong>
    </div>`;
    html += `<div class="tree-children">`;
    const roots = folders.filter(f => !f.parent);
    html += buildSubTree(folders, roots, nid, 1);
    html += `</div>`;
  }

  treeView.innerHTML = html;

  // 点击展开/折叠
  treeView.querySelectorAll('.tree-arrow').forEach(arrow => {
    arrow.addEventListener('click', function(e) {
      e.stopPropagation();
      this.classList.toggle('expanded');
      const children = this.parentElement.nextElementSibling;
      if (children) children.style.display = children.style.display === 'none' ? 'block' : 'none';
    });
  });
}
function buildSubTree(allFolders, items, nodeId, depth) {
  let html = '';
  items.forEach(f => {
    const isActive = currentViewNodeId === nodeId && currentFolder === f.id;
    const children = allFolders.filter(c => c.parent === f.id);
    html += `<div class="tree-item ${isActive?'active':''}" data-folder-id="${escapeHtml(f.id)}" data-node-id="${escapeHtml(nodeId)}" onclick="event.stopPropagation();selectTreeNode('${escapeAttr(nodeId)}','${escapeAttr(f.id)}')" oncontextmenu="folderContextMenu(event,'${escapeAttr(f.id)}','${escapeAttr(nodeId)}')" ondragover="folderDragOver(event,'${escapeAttr(f.id)}')" ondragleave="folderDragLeave(event)" ondrop="folderDrop(event,'${escapeAttr(f.id)}')">
      <span class="tree-indent" style="width:${depth*16}px"></span>
      ${children.length?`<span class="tree-arrow expanded">▼</span>`:`<span style="width:14px;display:inline-block"></span>`}
      📁 ${escapeHtml(f.name)}
    </div>`;
    if (children.length) {
      html += `<div class="tree-children" style="display:block">`;
      html += buildSubTree(allFolders, children, nodeId, depth + 1);
      html += `</div>`;
    }
  });
  return html;
}
/* ==================== 拖拽移动文件 ==================== */
let dragFileNames = [];

function dragFileStart(e, filename) {
  // 如果当前有已选中的文件且包含此文件，拖拽全部选中文件
  if (selectedFiles.size > 0 && selectedFiles.has(filename)) {
    dragFileNames = [...selectedFiles];
  } else {
    dragFileNames = [filename];
  }
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragFileNames.join('\n'));
  e.currentTarget.classList.add('dragging');
}

function dragFileEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

// 目录树项接受拖放
function folderDragOver(e, folderId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function folderDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function folderDrop(e, folderId) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!dragFileNames.length) return;
  toast(`📁 移动 ${dragFileNames.length} 个文件...`);
  let ok = 0, err = 0;
  for (const name of dragFileNames) {
    try {
      await api('PUT', `${BASE}/api/files/${encodeURIComponent(name)}/move`, { folder: folderId });
      ok++;
    } catch(e) { err++; }
  }
  toast(folderId ? `✅ 已移动 ${ok} 个文件` + (err ? `，${err} 个失败` : '') : `✅ 已移到根目录`);
  await loadFiles(); renderFileGrid();
  dragFileNames = [];
  selectedFiles.clear(); updateBatchUI();
}

// 上传区域也接受文件拖放（用于上传，优先级低于树节点）
uploadZone.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); uploadZone.classList.add('drag-over'); }
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) doUploadMultiple(e.dataTransfer.files);
});

async function selectTreeNode(nodeId, folderId) {
  currentViewNodeId = nodeId; currentFolder = folderId;
  updateBreadcrumb();
  renderFileGrid();
  renderTree();

  // 如果选择了远程节点，聚合远程文件
  if (nodeId && nodeId !== (document.getElementById('siNodeId')?.textContent||'')) {
    try {
      await loadFiles(); // 这会从聚合列表加载
    } catch(e) {}
  }
}
function updateBreadcrumb() {
  let parts = [];
  if (currentViewNodeId) {
    parts.push({ label: `📁 ${currentViewNodeId}`, nodeId: currentViewNodeId, folderId: null });
  }
  if (currentFolder) {
    // 查找文件夹路径
    const folder = allFolders.find(f => f.id === currentFolder);
    if (folder) {
      const path = [];
      let current = folder;
      while (current) {
        path.unshift({ label: current.name, nodeId: current.nodeId, folderId: current.id });
        current = current.parent ? allFolders.find(f => f.id === current.parent) : null;
      }
      parts = parts.concat(path);
    }
  }
  if (!parts.length) {
    parts = [{ label: '📁 根目录', nodeId: null, folderId: null }];
  }
  breadcrumb.innerHTML = parts.map((p, i) => {
    const sep = i > 0 ? ' <span class="bc-sep">›</span> ' : '';
    return sep + `<span class="bc-item" onclick="selectTreeNode('${escapeAttr(p.nodeId||'')}','${escapeAttr(p.folderId||'')}')">${p.label}</span>`;
  }).join('');
}

/* ==================== 文件夹操作 ==================== */
async function createFolder() {
  const name = prompt('请输入文件夹名称:');
  if (!name || !name.trim()) return;
  const parent = currentFolder;
  const nodeId = currentViewNodeId || document.getElementById('siNodeId')?.textContent || 'local';
  try {
    await api('POST', `${BASE}/api/folders/create`, { name: name.trim(), parent, nodeId });
    toast('✅ 文件夹已创建');
    await loadFolders();
    renderTree();
  } catch(e) { toast('创建失败: '+e.message); }
}
async function deleteFolder(folderId) {
  showConfirm('确定要删除此文件夹吗？（文件不会被删除）', async () => {
    try {
      await api('DELETE', `${BASE}/api/folders/${encodeURIComponent(folderId)}`);
      toast('已删除文件夹');
      if (currentFolder === folderId) { currentFolder = null; updateBreadcrumb(); }
      await loadFolders(); renderTree(); renderFileGrid();
    } catch(e) { toast('删除失败: '+e.message); }
    hideConfirm();
  });
}
function folderContextMenu(e, folderId, nodeId) {
  e.preventDefault();
  contextFile = null;
  contextMenu.innerHTML = `
    <div class="context-item" data-action="newSubFolder">📁 新建子文件夹</div>
    <div class="context-item" data-action="renameFolder">✏ 重命名</div>
    <div class="context-item" data-action="deleteFolder">🗑 删除文件夹</div>
  `;
  contextMenu._folderId = folderId; contextMenu._nodeId = nodeId;
  contextMenu.style.display='block'; contextMenu.style.left=Math.min(e.clientX,window.innerWidth-180)+'px'; contextMenu.style.top=Math.min(e.clientY,window.innerHeight-150)+'px';
}

/* ==================== 设置面板 ==================== */
function openSettings() { settingsDrawer.classList.add('open'); }
function closeSettings() { settingsDrawer.classList.remove('open'); }
settingsCloseBtn.addEventListener('click', closeSettings);
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsOverlay')?.addEventListener('click', closeSettings);

// Tab 切换
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.settings-tab-content').forEach(c=>c.classList.remove('active'));
    tab.classList.add('active');
    const target = $('#tab-'+tab.dataset.tab); if (target) target.classList.add('active');
  });
});

// 🌐 一键连接：粘贴口令
$('#connectBtn').addEventListener('click', async () => {
  const token = $('#connectToken').value.trim();
  if (!token) return toast('请粘贴连接口令');
  const btn = $('#connectBtn');
  btn.disabled = true; btn.textContent = '连接中...';
  const resultEl = $('#connectResult');
  try {
    const d = await api('POST', `${BASE}/api/cluster/connect`, { token });
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<p style="color:#22c55e;">✅ ${escapeHtml(d.message)}</p>`;
    toast('✅ ' + d.message);
    $('#connectToken').value = '';
    await loadClusterInfo();
    await loadFiles();
    await loadFolders();
    renderTree();
    await loadPeerStatus();
  } catch(e) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<p style="color:#ef4444;">❌ ${escapeHtml(e.message)}</p>`;
    toast('连接失败: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '连接';
  }
});

// 粘贴连接口令时自动触发（如果剪贴板有内容且在设置页）
document.addEventListener('paste', (e) => {
  const connectInput = $('#connectToken');
  if (!connectInput || document.activeElement !== connectInput) return;
  // 粘贴事件会自动填入，在短暂延迟后自动连接
  const text = (e.clipboardData || window.clipboardData)?.getData('text');
  if (text && text.startsWith('CDC')) {
    setTimeout(() => {
      if (connectInput.value.trim().startsWith('CDC')) {
        $('#connectBtn').click();
      }
    }, 200);
  }
});

// 手动添加对等节点
$('#addPeerBtn').addEventListener('click', async () => {
  const nodeId = $('#peerNodeId').value.trim();
  const endpoint = $('#peerEndpoint').value.trim();
  const secret = $('#peerSecret').value.trim();
  const name = $('#peerName').value.trim();
  if (!nodeId || !endpoint || !secret) return toast('请填写完整信息');
  try {
    await api('POST', `${BASE}/api/cluster/peers`, { nodeId, endpoint, secret, nodeName: name });
    toast('✅ 节点已添加，即时生效');
    await loadClusterInfo();
    await loadFiles();
    await loadFolders();
    renderTree();
    $('#peerNodeId').value='';$('#peerName').value='';$('#peerEndpoint').value='';$('#peerSecret').value='';
    } catch(e) { toast('添加失败: '+e.message); }
});

// 粘贴分享信息
$('#pastePeerBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const info = JSON.parse(text);
    if (info.nodeId) $('#peerNodeId').value = info.nodeId;
    if (info.endpoint) $('#peerEndpoint').value = info.endpoint;
    if (info.secret) $('#peerSecret').value = info.secret;
    if (info.nodeName) $('#peerName').value = info.nodeName;
    toast('✅ 已粘贴连接信息');
  } catch(e) {
    try {
      // 降级：尝试旧式 execCommand 读取
      const ta = document.createElement('textarea');
      document.body.appendChild(ta); ta.focus();
      document.execCommand('paste');
      const text = ta.value;
      document.body.removeChild(ta);
      const info = JSON.parse(text);
      if (info.nodeId) $('#peerNodeId').value = info.nodeId;
      if (info.endpoint) $('#peerEndpoint').value = info.endpoint;
      if (info.secret) $('#peerSecret').value = info.secret;
      toast('✅ 已粘贴');
    } catch(e2) { toast('粘贴失败，请手动填写'); }
  }
});

// ==================== 对等节点管理 ====================
async function removePeer(nodeId) {
  showConfirm(`确定要移除节点 "${nodeId}" 吗？`, async () => {
    try {
      await api('DELETE', `${BASE}/api/cluster/peers/${encodeURIComponent(nodeId)}`);
      toast('已移除节点');
      await loadClusterInfo();
    } catch(e) { toast('移除失败: '+e.message); }
    hideConfirm();
  });
}

// 复制连接口令（一键连接口令）
// 📋 复制地址
$('#copyEpOnlyBtn').addEventListener('click', () => {
  const ep = document.getElementById('siEndpoint');
  if (ep && ep.textContent) copyText(ep.textContent);
});

// 📋 从剪贴板粘贴到连接输入框
$('#pasteTokenBtn').addEventListener('click', async () => {
  const input = $('#connectToken');
  try {
    const text = await navigator.clipboard.readText();
    if (text) { input.value = text; toast('✅ 已粘贴，点击「连接」'); }
    else toast('剪贴板为空');
  } catch(e) {
    toast('无法读取剪贴板，请手动 Ctrl+V 粘贴');
  }
});

$('#copyEpBtn').addEventListener('click', () => {
  const ep = document.getElementById('siEndpoint');
  if (ep && ep.textContent) copyText(ep.textContent);
});

$('#copyShareBtn').addEventListener('click', () => {
  const token = $('#shareInfo')._token;
  if (!token) {
    // 没有口令，尝试生成
    const text = $('#shareInfo').value;
    if (!text || text.startsWith('⚠')) return toast('请先配置 CLUSTER_SECRET');
    copyToClipboard(text).then(() => toast('✅ 已复制，发给对方在「一键连接」中粘贴'), () => toast('复制失败'));
    return;
  }
  copyToClipboard(token).then(() => toast('✅ 连接口令已复制！发给对方一键粘贴连接'), () => toast('复制失败'));
});

// 复制 JSON 格式
$('#copyJsonBtn').addEventListener('click', () => {
  const json = $('#shareInfo')._json;
  if (!json) return toast('无 JSON 信息');
  copyToClipboard(json).then(() => toast('✅ JSON 已复制'), () => toast('复制失败'));
});

// 二维码分享
$('#qrShareBtn').addEventListener('click', () => {
  const json = $('#shareInfo')._json;
  if (!json) return toast('无分享信息');
  const img = $('#shareQrImg');
  const link = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(json)}`;
  if (img.style.display === 'none') {
    img.src = link;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }
});

// 保存节点名称
$('#saveNodeNameBtn').addEventListener('click', async () => {
  const name = $('#setNodeName').value.trim();
  if (!name) return toast('请输入名称');
  try {
    await api('PUT', `${BASE}/api/cluster/settings`, { nodeName: name });
    toast('✅ 名称已保存');
    document.getElementById('siNodeName').textContent = name;
  } catch(e) { toast('保存失败: '+e.message); }
});

/* ==================== 树侧栏切换 ==================== */
treeToggleBtn.addEventListener('click', () => {
  treeSidebar.classList.toggle('collapsed');
});

/* ==================== 右键菜单增强 ==================== */
function showContextMenu(e, filename) {
  e.preventDefault();
  contextFile = filename;
  contextMenu._folderId = null; contextMenu._nodeId = null;
  contextMenu.innerHTML = `
    <div class="context-item" data-action="download">⬇ 下载</div>
    <div class="context-item" data-action="copyKey">📋 复制密钥</div>
    <div class="context-item" data-action="copyLink">🔗 复制链接</div>
    <div class="context-item" data-action="qrCode">📱 二维码</div>
    <div class="context-item" data-action="keySettings">⚙ 密钥设置</div>
    <div class="context-item" data-action="moveHere">📁 移入当前文件夹</div>
    <div class="context-item" data-action="moveRoot">📂 移到根目录</div>
    <div class="context-item" data-action="delete">🗑 删除</div>
  `;
  contextMenu.style.display='block'; contextMenu.style.left=Math.min(e.clientX,window.innerWidth-180)+'px'; contextMenu.style.top=Math.min(e.clientY,window.innerHeight-260)+'px';
}
document.addEventListener('click', () => { contextMenu.style.display='none'; });
contextMenu.addEventListener('click', async (e) => {
  const action = e.target.closest('.context-item')?.dataset.action;
  if (!action) return;
  contextMenu.style.display='none';

  // 文件夹右键
  if (contextMenu._folderId && ['newSubFolder','renameFolder','deleteFolder'].includes(action)) {
    const fid = contextMenu._folderId;
    if (action === 'newSubFolder') {
      const name = prompt('子文件夹名称:'); if (!name?.trim()) return;
      try { await api('POST', `${BASE}/api/folders/create`, { name: name.trim(), parent: fid, nodeId: contextMenu._nodeId }); toast('✅ 已创建'); await loadFolders(); renderTree(); } catch(e) { toast(e.message); }
    } else if (action === 'renameFolder') {
      const name = prompt('新名称:'); if (!name?.trim()) return;
      try { await api('PUT', `${BASE}/api/folders/${encodeURIComponent(fid)}/rename`, { name: name.trim() }); toast('✅ 已重命名'); await loadFolders(); renderTree(); } catch(e) { toast(e.message); }
    } else if (action === 'deleteFolder') {
      await deleteFolder(fid);
    }
    contextMenu._folderId = null; contextMenu._nodeId = null;
    return;
  }

  if (!contextFile) return;
  const f = contextFile;
  switch (action) {
    case 'download': downloadFile(f); break;
    case 'copyKey': { const x=allFiles.find(y=>y.name===f); if(x?.key)copyKey(x.key); break; }
    case 'copyLink': { const x=allFiles.find(y=>y.name===f); if(x?.key)copyShareLink(x.key); break; }
    case 'qrCode': { const x=allFiles.find(y=>y.name===f); if(x?.key)showQR(x.key); break; }
    case 'keySettings': showKeySettings(f); break;
    case 'moveHere': moveFileTo(f, currentFolder); break;
    case 'moveRoot': moveFileTo(f, null); break;
    case 'delete': deleteFile(f); break;
  }
  contextFile = null;
});

async function moveFileTo(filename, folder) {
  try {
    await api('PUT', `${BASE}/api/files/${encodeURIComponent(filename)}/move`, { folder });
    toast(folder ? '已移入文件夹' : '已移到根目录');
    await loadFiles(); renderFileGrid();
  } catch(e) { toast('移动失败: '+e.message); }
}

/* ==================== 上传 ==================== */
uploadZone.addEventListener('click', () => fileInput.click());
$('#cameraBtn').addEventListener('click', () => cameraInput.click());
fileInput.addEventListener('change', () => { if(fileInput.files.length>0){doUploadMultiple(fileInput.files);fileInput.value='';} });
cameraInput.addEventListener('change', () => { if(cameraInput.files.length>0){doUploadMultiple(cameraInput.files);cameraInput.value='';} });
document.addEventListener('paste', (e) => {
  if (loginPage.style.display!=='none') { const text=(e.clipboardData||window.clipboardData).getData('text').trim(); if(text&&text.length<=20){keyInput.value=text;setTimeout(()=>doLogin(text),100);} return; }
  if (adminPage.style.display==='none') return;
  const items=e.clipboardData?.items; if(!items)return;
  const imageFiles=[]; for(const item of items){if(item.type.startsWith('image/')){const f=item.getAsFile();if(f)imageFiles.push(f);}}
  if(imageFiles.length>0){e.preventDefault();doUploadMultiple(imageFiles);toast(`📋 已粘贴 ${imageFiles.length} 张图片`);}
});
async function doUploadMultiple(files) {
  progressContainer.style.display='block'; progressFill.style.width='0%'; progressText.textContent='准备上传...'; progressDetail.textContent=`${files.length} 个文件`;
  let totalSize=0; for(const f of files) totalSize+=f.size;
  const formData=new FormData(); for(const f of files) formData.append('files',f);
  // 上传到当前浏览的文件夹
  if (currentFolder) formData.append('folder', currentFolder);
  try {
    await apiUpload(`${BASE}/api/upload`, formData, (loaded,total)=>{const pct=Math.round((loaded/total)*100);progressFill.style.width=pct+'%';progressText.textContent=pct+'%  '+formatSize(loaded)+' / '+formatSize(total);progressDetail.textContent=`${files.length} 个文件 · 总大小 ${formatSize(totalSize)}`;});
    toast('✅ 上传成功');
    loadFiles(); loadDiskInfo();
  } catch(e) { toast('❌ '+e.message); }
  finally { setTimeout(()=>{progressContainer.style.display='none';},600); }
}

/* ==================== 预览 / 下载 / 删除 ==================== */
function previewFile(filename,type) {
  previewTitle.textContent=filename;
  const url=`${BASE}/api/preview/${encodeURIComponent(filename)}`;
  if(type==='image')previewBody.innerHTML=`<img src="${url}" alt="${escapeHtml(filename)}">`;
  else if(type==='video')previewBody.innerHTML=`<video src="${url}" controls autoplay></video>`;
  else if(type==='audio')previewBody.innerHTML=`<audio src="${url}" controls autoplay></audio>`;
  else previewBody.innerHTML=`<div class="preview-unsupported">此文件类型不支持预览</div>`;
  previewOverlay.style.display='flex';
}
previewClose.addEventListener('click',()=>{previewBody.innerHTML='';previewOverlay.style.display='none';});
previewOverlay.addEventListener('click',e=>{if(e.target===previewOverlay){previewBody.innerHTML='';previewOverlay.style.display='none';}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&previewOverlay.style.display!=='none'){previewBody.innerHTML='';previewOverlay.style.display='none';}});
function downloadFile(filename) { const a=document.createElement('a');a.href=`${BASE}/api/download/${encodeURIComponent(filename)}`;a.click(); }
async function deleteFile(filename) {
  showConfirm(`确定要删除「${filename}」吗？`,async()=>{try{await api('DELETE',`${BASE}/api/files/${encodeURIComponent(filename)}`);toast('已删除: '+filename);loadFiles();loadDiskInfo();}catch(e){toast('删除失败: '+e.message);}hideConfirm();});
}
function copyText(text) {
  copyToClipboard(text).then(() => toast('✅ 已复制: ' + text), () => toast('复制失败'));
}
function copyToClipboard(text) {
  if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(text);
  return new Promise((resolve,reject)=>{const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px;';document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy');resolve();}catch(e){reject(e);}document.body.removeChild(ta);});
}
function copyKey(key) { copyToClipboard(key).then(()=>toast('密钥已复制: '+key),()=>toast('复制失败')); }
function copyShareLink(key) { const link=location.origin+location.pathname+'?key='+key; copyToClipboard(link).then(()=>toast('分享链接已复制 📋'),()=>toast('复制失败')); }
function showQR(key) { const link=location.origin+location.pathname+'?key='+key; qrImage.src=`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(link)}`; qrKey.textContent='密钥: '+key; qrOverlay.style.display='flex'; }
qrClose_.addEventListener('click',()=>{qrOverlay.style.display='none';});
qrOverlay.addEventListener('click',e=>{if(e.target===qrOverlay)qrOverlay.style.display='none';});

/* ==================== 密钥设置 ==================== */
function showKeySettings(filename) {
  keySettingsTargetFile=filename;keySettingsFilename.textContent=filename;keyTTL.value='0';keyMaxDownloads.value='0';keyOneTime.checked=false;keySettingsResult.style.display='none';keySettingsOverlay.style.display='flex';
}
keySettingsSave.addEventListener('click',async()=>{if(!keySettingsTargetFile)return;const ttl=parseInt(keyTTL.value),maxDl=parseInt(keyMaxDownloads.value),oneTime=keyOneTime.checked;try{const d=await api('POST',`${BASE}/api/files/${encodeURIComponent(keySettingsTargetFile)}/rekey`,{expiresIn:ttl||null,maxDownloads:maxDl||null,oneTime});$('#newKeyValue').textContent=d.key;keySettingsResult.style.display='block';toast('🔑 密钥已更新');loadFiles();}catch(e){toast('设置失败: '+e.message);}});
keySettingsCancel.addEventListener('click',()=>{keySettingsOverlay.style.display='none';});
keySettingsOverlay.addEventListener('click',e=>{if(e.target===keySettingsOverlay)keySettingsOverlay.style.display='none';});

/* ==================== 多选与批量 ==================== */
function toggleSelect(filename,checked) { if(checked)selectedFiles.add(filename);else selectedFiles.delete(filename);updateBatchUI(); }
function updateBatchUI() { batchActions.style.display=selectedFiles.size>0?'flex':'none'; document.querySelectorAll('.file-card').forEach(el=>el.classList.toggle('selected',selectedFiles.has(el.dataset.filename))); }
batchDeleteBtn.addEventListener('click',()=>{if(selectedFiles.size===0)return;showConfirm(`确定要删除选中的 ${selectedFiles.size} 个文件吗？`,async()=>{try{const r=await api('POST',`${BASE}/api/files/delete-batch`,{filenames:[...selectedFiles]});toast(`✅ 已删除 ${r.deleted.length} 个`);if(r.failed.length>0)toast(`⚠ ${r.failed.length} 个失败`);selectedFiles.clear();updateBatchUI();loadFiles();loadDiskInfo();}catch(e){toast('删除失败: '+e.message);}hideConfirm();});});
batchCancelBtn.addEventListener('click',()=>{selectedFiles.clear();updateBatchUI();});

/* ==================== 文本片段 ==================== */
snippetToggle.addEventListener('click',()=>{snippetEditor.style.display=snippetEditor.style.display==='none'?'block':'none';if(snippetEditor.style.display==='block')snippetText.focus();});
snippetCancelBtn.addEventListener('click',()=>{snippetEditor.style.display='none';snippetText.value='';});
snippetSaveBtn.addEventListener('click',async()=>{const c=snippetText.value.trim();if(!c)return toast('请输入文本');try{const d=await api('POST',`${BASE}/api/snippets`,{content:c});const link=`${location.origin}${location.pathname}?snippet=${d.key}`;await copyToClipboard(link);toast('✅ 片段链接已复制');snippetEditor.style.display='none';snippetText.value='';}catch(e){toast('创建失败: '+e.message);}});

/* ==================== 暗色模式 ==================== */
const themeToggle=$('#globalThemeToggle'),savedTheme=localStorage.getItem('cloud-drive-theme');
if(savedTheme==='light')document.body.classList.add('light-mode');else if(savedTheme==='dark')document.body.classList.add('dark-mode');
if(themeToggle){themeToggle.addEventListener('click',()=>{if(document.body.classList.contains('light-mode')){document.body.classList.remove('light-mode');document.body.classList.add('dark-mode');localStorage.setItem('cloud-drive-theme','dark');}else if(document.body.classList.contains('dark-mode')){document.body.classList.remove('dark-mode');localStorage.setItem('cloud-drive-theme','light');}else{document.body.classList.add('dark-mode');localStorage.setItem('cloud-drive-theme','dark');}});}

/* ==================== 确认弹窗 ==================== */
confirmCancel.addEventListener('click',hideConfirm);
confirmOk.addEventListener('click',()=>{if(confirmCallback)confirmCallback();});
confirmOverlay.addEventListener('click',e=>{if(e.target===confirmOverlay)hideConfirm();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){hideConfirm();closeSettings();}});

/* ==================== 事件绑定 ==================== */
loginBtn.addEventListener('click',()=>doLogin());
keyInput.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
$('#adminLogoutBtn').addEventListener('click',doLogout);
$('#viewerLogoutBtn').addEventListener('click',doLogout);
newFolderBtn.addEventListener('click', createFolder);
$('#settingsBtn').addEventListener('click', openSettings);

/* ==================== PWA ==================== */
if('serviceWorker' in navigator) { navigator.serviceWorker.register(`${BASE}/sw.js?v=3`).catch(()=>{}); }

/* ==================== 片段 URL ==================== */
(async()=>{
  const snippetKey=new URLSearchParams(location.search).get('snippet');
  if(snippetKey){try{const d=await api('GET',`${BASE}/api/snippets/${snippetKey}`);const el=document.createElement('div');el.style.cssText='position:fixed;inset:0;background:var(--bg);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;';el.innerHTML=`<div style="background:var(--surface);border-radius:12px;padding:28px;max-width:500px;width:100%"><h3>📝 文本片段</h3><pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14px;line-height:1.6;margin-bottom:16px;color:var(--text);">${escapeHtml(d.content)}</pre><p style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">${formatDate(d.createdAt)}</p><button class="btn btn-primary" onclick="this.closest('div').parentElement.remove()" style="width:100%">关闭</button></div>`;document.body.appendChild(el);history.replaceState({},'',location.pathname);}catch(e){}}
})();

/* ==================== 访问者 ==================== */
async function loadViewerFile(filename) {
  try{const d=await api('GET',`${BASE}/api/files`);if(d.files.length===0){viewerFileCard.innerHTML=`<div class="file-icon">❓</div><div class="file-name">文件不存在或已被删除</div><div class="file-meta">请联系管理员重新获取密钥</div>`;return;}const f=d.files[0];viewerFileCard.innerHTML=`<div class="file-icon">${fileIcon(f.name)}</div><div class="file-name">${escapeHtml(f.name)}</div><div class="file-meta"><span>${formatSize(f.size)}</span><span>${formatDate(f.modified)}</span></div><button class="btn btn-primary" onclick="downloadFile('${escapeAttr(f.name)}')">⬇ 下载文件</button>`;}catch(e){toast('加载失败');}
}
/* ==================== 启动 ==================== */
checkAuth();
