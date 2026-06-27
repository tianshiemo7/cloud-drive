const http = require('http');

const cookies = {};
function saveCookies(p, h) {
  const sc = h['set-cookie'];
  if (sc) cookies[p] = (cookies[p] || '') + sc.map(c => c.split(';')[0]).join('; ');
}

function api(method, port, path, body, extraHeaders) {
  return new Promise((resolve) => {
    const u = new URL(path, 'http://127.0.0.1:' + port);
    const hdrs = { 'Content-Type': 'application/json', ...extraHeaders || {} };
    const ck = cookies[port]; if (ck) hdrs['Cookie'] = ck;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: hdrs }, (res) => {
      saveCookies(port, res.headers);
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}

function uploadFile(port, filename, content, csrf, folder) {
  return new Promise((resolve) => {
    const boundary = '----TestBoundary' + Date.now();
    const parts = [];
    if (folder) {
      parts.push('--' + boundary);
      parts.push('Content-Disposition: form-data; name="folder"');
      parts.push('');
      parts.push(folder);
    }
    parts.push('--' + boundary);
    parts.push('Content-Disposition: form-data; name="files"; filename="' + filename + '"');
    parts.push('Content-Type: application/octet-stream');
    parts.push('');
    parts.push(content);
    parts.push('--' + boundary + '--');
    parts.push('');
    const body = parts.join('\r\n');

    const hdrs = { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'X-CSRF-Token': csrf };
    const ck = cookies[port]; if (ck) hdrs['Cookie'] = ck;
    const req = http.request({ hostname: '127.0.0.1', port: port, path: '/api/upload', method: 'POST', headers: hdrs }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.write(body); req.end();
  });
}

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ FAIL: ' + name); }
}

async function main() {
  const P = { A: 4010, B: 4020, C: 4030 };
  const K = { A: 'admin-key-a', B: 'admin-key-b', C: 'admin-key-c' };
  const CSRF = {};

  // ======== 1. Login ========
  console.log('\n=== 1. Authentication ===');
  for (const [n, port] of Object.entries(P)) {
    const r = await api('POST', port, '/api/login', { key: K[n] });
    CSRF[n] = r.data.csrf;
    check(n + ' login admin', r.data.role === 'admin');
  }

  // ======== 2. CSRF Protection ========
  console.log('\n=== 2. CSRF Protection ===');
  const noCsrf = await api('POST', P.A, '/api/folders/create', { name: 'hack' });
  check('CSRF rejected w/o token', noCsrf.status === 403);

  const badCsrf = await api('POST', P.A, '/api/folders/create', { name: 'hack' }, { 'X-CSRF-Token': 'bad-token' });
  check('CSRF rejected bad token', badCsrf.status === 403);

  // ======== 3. Folder Creation ========
  console.log('\n=== 3. Folder Operations ===');
  const f1 = await api('POST', P.A, '/api/folders/create', { name: 'Work Docs' }, { 'X-CSRF-Token': CSRF.A });
  check('Create folder', f1.data.success === true);
  const folderId = f1.data.id;

  const f2 = await api('POST', P.A, '/api/folders/create', { name: 'Sub Folder', parent: folderId }, { 'X-CSRF-Token': CSRF.A });
  check('Create subfolder', f2.data.success === true);

  // ======== 4. Folder-Aware Upload ========
  console.log('\n=== 4. Folder-Aware Upload ===');
  await uploadFile(P.A, 'root-file.txt', 'root content', CSRF.A);
  await uploadFile(P.A, 'folder-file.txt', 'folder content', CSRF.A, folderId);

  const files = await api('GET', P.A, '/api/files', null, { 'X-CSRF-Token': CSRF.A });
  const rootFile = files.data.files.find(f => f.name === 'root-file.txt');
  const folderFile = files.data.files.find(f => f.name === 'folder-file.txt');
  check('Root file uploaded', rootFile && rootFile.folder === 'node-A');
  check('Folder file has correct folder', folderFile && folderFile.folder === folderId);
  console.log('   root-file folder=' + (rootFile ? rootFile.folder : 'N/A'));
  console.log('   folder-file folder=' + (folderFile ? folderFile.folder : 'N/A'));

  // ======== 5. Move File to Root (the bug fix!) ========
  console.log('\n=== 5. Move-to-Root (consistency fix) ===');
  const moveR = await api('PUT', P.A, '/api/files/' + encodeURIComponent('folder-file.txt') + '/move', { folder: null }, { 'X-CSRF-Token': CSRF.A });
  check('Move to root success', moveR.data.success === true);
  check('Move to root sets nodeId folder', moveR.data.folder === 'node-A');
  console.log('   moved to folder=' + moveR.data.folder);

  const files2 = await api('GET', P.A, '/api/files', null, { 'X-CSRF-Token': CSRF.A });
  const moved = files2.data.files.find(f => f.name === 'folder-file.txt');
  check('Moved file has nodeId folder', moved && moved.folder === 'node-A');

  // ======== 6. Move to invalid folder ========
  console.log('\n=== 6. Move to Invalid Folder (validation) ===');
  const moveBad = await api('PUT', P.A, '/api/files/' + encodeURIComponent('root-file.txt') + '/move', { folder: 'nonexistent' }, { 'X-CSRF-Token': CSRF.A });
  check('Move to invalid folder rejected', moveBad.status === 404);

  // ======== 7. Prototype Bypass ========
  console.log('\n=== 7. Prototype Bypass Protection ===');
  const bypassUpload = await uploadFile(P.A, 'bypass-test.txt', 'test', CSRF.A, '__proto__');
  if (bypassUpload.data && bypassUpload.data.files) {
    const files3 = await api('GET', P.A, '/api/files', null, { 'X-CSRF-Token': CSRF.A });
    const bf = files3.data.files.find(f => f.name === 'bypass-test.txt');
    check('Prototype bypass: file goes to root', bf && bf.folder === 'node-A');
    console.log('   bypass file folder=' + (bf ? bf.folder : 'N/A'));
  }

  // ======== 8. XSS-safe Filenames ========
  console.log('\n=== 8. XSS-Safe Filenames ===');
  const xssName = '"onmouseover=alert(1)>';
  await uploadFile(P.A, xssName, 'xss test', CSRF.A);
  const files4 = await api('GET', P.A, '/api/files', null, { 'X-CSRF-Token': CSRF.A });
  const xssFile = files4.data.files.find(f => f.name === xssName);
  check('XSS filename stored correctly', !!xssFile);
  if (xssFile && xssFile.key) {
    const dl = await api('GET', P.A, '/api/download/' + encodeURIComponent(xssName), null, { 'X-CSRF-Token': CSRF.A });
    check('XSS file downloadable', dl.status === 200);
  }

  // ======== 9. Rate Limiting ========
  console.log('\n=== 9. Upload Rate Limiting ===');
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const r = await uploadFile(P.A, 'rate-test-' + i + '.txt', 'test', CSRF.A);
    if (r.status === 429) { limited = true; console.log('   rate limited at upload #' + (i + 1)); break; }
  }
  check('Upload rate limiter triggers', limited);

  // ======== 10. Delete Folder Reparenting ========
  console.log('\n=== 10. Delete Folder Reparenting ===');
  const f3 = await api('POST', P.A, '/api/folders/create', { name: 'TempFolder' }, { 'X-CSRF-Token': CSRF.A });
  const tempId = f3.data.id;
  await uploadFile(P.A, 'temp-file.txt', 'temp', CSRF.A, tempId);
  const delF = await api('DELETE', P.A, '/api/folders/' + encodeURIComponent(tempId), null, { 'X-CSRF-Token': CSRF.A });
  check('Delete folder OK', delF.data.success);
  const files5 = await api('GET', P.A, '/api/files', null, { 'X-CSRF-Token': CSRF.A });
  const tempFile = files5.data.files.find(f => f.name === 'temp-file.txt');
  check('Temp file reparented to root', tempFile && tempFile.folder === 'node-A');

  // ======== 11. Cluster One-Click Connect ========
  console.log('\n=== 11. Cluster One-Click Connect ===');
  const sA = await api('GET', P.A, '/api/cluster/settings', null, { 'X-CSRF-Token': CSRF.A });
  let token = sA.data.shareToken;
  if (!token) {
    const sA2 = await api('GET', P.A, '/api/cluster/settings', null, { 'X-CSRF-Token': CSRF.A });
    token = sA2.data.shareToken;
  }
  if (token) {
    const cB = await api('POST', P.B, '/api/cluster/connect', { token }, { 'X-CSRF-Token': CSRF.B });
    check('B connect to A', cB.data.success === true);
    const cC = await api('POST', P.C, '/api/cluster/connect', { token }, { 'X-CSRF-Token': CSRF.C });
    check('C connect to A', cC.data.success === true);

    // Verify B sees A's files
    const fB = await api('GET', P.B, '/api/files', null, { 'X-CSRF-Token': CSRF.B });
    check('B sees aggregated files', (fB.data.files || []).length > 0);
    console.log('   B file count: ' + (fB.data.files || []).length);

    if (fB.data.nodes) {
      check('B sees multiple nodes', fB.data.nodes.length > 1);
      console.log('   B nodes: ' + fB.data.nodes.map(n => n.nodeId).join(', '));
    }
  } else {
    console.log('   No share token (CLUSTER_SECRET not set) - skipping cluster tests');
  }

  // ======== Summary ========
  console.log('\n========================================');
  console.log('  TEST SUMMARY');
  console.log('  Passed: ' + pass);
  console.log('  Failed: ' + fail);
  console.log('  Total:  ' + (pass + fail));
  console.log('========================================');
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
