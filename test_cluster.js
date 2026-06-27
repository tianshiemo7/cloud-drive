// ==================== 集群连接测试 ====================
// 模拟三个节点：A(3010) B(3020) C(3030)
// 流程: A 生成口令 → B 一键连接 → C 一键连接 → 验证互通

const http = require('http');

function api(method, port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data, error: 'parse-error' });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Cookie jar
const cookies = {};

function setCookies(port, resHeaders) {
  const setCookie = resHeaders['set-cookie'];
  if (setCookie) {
    cookies[port] = (setCookie || []).map(c => c.split(';')[0]).join('; ');
  }
}

function getCookie(port) {
  return cookies[port] || '';
}

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  云盘集群一键连接测试');
  console.log('═══════════════════════════════════════════\n');

  const ports = { A: 3010, B: 3020, C: 3030 };
  const keys = { A: 'test-node-a', B: 'test-node-b', C: 'test-node-c' };
  const csrf = {};

  // ============ 1. 登录所有节点 ============
  console.log('📌 Step 1: 登录三个节点');
  for (const [name, port] of Object.entries(ports)) {
    const res = await api('POST', port, '/api/login', { key: keys[name] });
    setCookies(port, res.headers);
    csrf[name] = res.data.csrf;
    console.log(`  ${name}(:${port}) 登录: role=${res.data.role} csrf=${csrf[name].substring(0,8)}...`);
  }

  // ============ 2. A 生成连接口令 ============
  console.log('\n📌 Step 2: 节点 A 生成连接口令');
  const settingsA = await api('GET', ports.A, '/api/cluster/settings', null, {
    'X-CSRF-Token': csrf.A,
    Cookie: getCookie(ports.A)
  });
  const token = settingsA.data.shareToken;
  if (!token) {
    console.log('  ❌ A 未能生成口令！请检查 CLUSTER_SECRET');
    process.exit(1);
  }
  console.log(`  口令: ${token.substring(0, 50)}...`);
  console.log(`  A 集群状态: enabled=${settingsA.data.enabled} peers=${settingsA.data.peers.length}`);

  // ============ 3. B 粘贴口令连接 A ============
  console.log('\n📌 Step 3: 节点 B 一键连接 A');
  const connectB = await api('POST', ports.B, '/api/cluster/connect', { token }, {
    'X-CSRF-Token': csrf.B,
    Cookie: getCookie(ports.B)
  });
  if (connectB.data.success) {
    console.log(`  ✅ ${connectB.data.message}`);
    console.log(`  对等节点: ${connectB.data.peer.nodeId} (${connectB.data.peer.endpoint})`);
    console.log(`  集群已启用: ${connectB.data.clusterEnabled}`);
  } else {
    console.log(`  ❌ 连接失败: ${JSON.stringify(connectB.data)}`);
  }

  // ============ 4. C 粘贴口令连接 A ============
  console.log('\n📌 Step 4: 节点 C 一键连接 A');
  const connectC = await api('POST', ports.C, '/api/cluster/connect', { token }, {
    'X-CSRF-Token': csrf.C,
    Cookie: getCookie(ports.C)
  });
  if (connectC.data.success) {
    console.log(`  ✅ ${connectC.data.message}`);
    console.log(`  集群已启用: ${connectC.data.clusterEnabled}`);
  } else {
    console.log(`  ❌ 连接失败: ${JSON.stringify(connectC.data)}`);
  }

  // ============ 5. 验证 B 的对等节点状态 ============
  console.log('\n📌 Step 5: 验证 B 的对等节点状态');
  const peersB = await api('GET', ports.B, '/api/cluster/peers/status', null, {
    'X-CSRF-Token': csrf.B,
    Cookie: getCookie(ports.B)
  });
  console.log(`  B 的对等节点:`);
  for (const p of (peersB.data.peers || [])) {
    console.log(`    ${p.online ? '🟢' : '🔴'} ${p.nodeId} (${p.endpoint}) ${p.online ? '在线' : '离线: ' + p.error}`);
  }

  // ============ 6. B 上传文件 → A 查看跨节点文件 ============
  console.log('\n📌 Step 6: 在 B 上上传测试文件');
  // 创建临时测试文件并上传
  const fs = require('fs');
  const testFile = require('path').join(require('os').tmpdir(), `test_upload_${Date.now()}.txt`);
  fs.writeFileSync(testFile, '集群测试文件 - 来自节点B');

  const uploadRes = await new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const fileContent = fs.readFileSync(testFile);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="test-from-B.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const opts = {
      hostname: '127.0.0.1', port: ports.B,
      path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-CSRF-Token': csrf.B,
        'Content-Length': body.length,
        Cookie: getCookie(ports.B)
      }
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  fs.unlinkSync(testFile);

  if (uploadRes.data.success) {
    console.log(`  ✅ B 上传成功: ${JSON.stringify(uploadRes.data.files.map(f => f.name + ' (密钥:' + f.key + ')'))}`);
  } else {
    console.log(`  ❌ B 上传失败: ${JSON.stringify(uploadRes.data)}`);
  }

  // ============ 7. A 查看聚合文件列表（应能看到 B 的远程文件） ============
  console.log('\n📌 Step 7: 节点 A 请求聚合文件列表（应含 B 的文件）');
  const filesA = await api('GET', ports.A, '/api/files', null, {
    'X-CSRF-Token': csrf.A,
    Cookie: getCookie(ports.A)
  });
  console.log(`  A 看到的文件数: ${(filesA.data.files || []).length}`);
  for (const f of (filesA.data.files || [])) {
    console.log(`    📄 ${f.name} (${f.size}B) nodeId=${f.nodeId || '?'}`);
  }
  if (filesA.data.nodes) {
    console.log(`  节点状态:`);
    for (const n of filesA.data.nodes) {
      console.log(`    ${n.error ? '🔴' : '🟢'} ${n.nodeId}: ${n.fileCount}个文件 ${n.error || ''}`);
    }
  }

  // ============ 8. C 也能看到聚合文件 ============
  console.log('\n📌 Step 8: 节点 C 请求聚合文件列表');
  const filesC = await api('GET', ports.C, '/api/files', null, {
    'X-CSRF-Token': csrf.C,
    Cookie: getCookie(ports.C)
  });
  console.log(`  C 看到的文件数: ${(filesC.data.files || []).length}`);
  for (const f of (filesC.data.files || [])) {
    console.log(`    📄 ${f.name} (${f.size}B) nodeId=${f.nodeId || '?'}`);
  }

  // ============ 9. C 通过文件密钥登录（跨节点查找） ============
  if (uploadRes.data.success && uploadRes.data.files.length > 0) {
    const fileKey = uploadRes.data.files[0].key;
    console.log(`\n📌 Step 9: 在 C 上用文件密钥 "${fileKey}" 登录（跨节点查找）`);
    const viewerLogin = await api('POST', ports.C, '/api/login', { key: fileKey });
    console.log(`  结果: success=${viewerLogin.data.success} role=${viewerLogin.data.role} sourceNodeId=${viewerLogin.data.sourceNodeId || 'local'} filename=${viewerLogin.data.filename || ''}`);
    if (viewerLogin.data.success && viewerLogin.data.sourceNodeId) {
      console.log('  ✅ 跨节点密钥查找成功！');
    } else {
      console.log(`  ℹ️ 结果: ${JSON.stringify(viewerLogin.data)}`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  测试完成！');
  console.log('═══════════════════════════════════════════');
}

run().catch(e => {
  console.error('测试出错:', e.message);
  process.exit(1);
});
