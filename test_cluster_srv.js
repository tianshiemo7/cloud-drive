const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const cookies = {};
function saveCookies(port, headers) {
  const sc = headers["set-cookie"];
  if (sc) cookies[port] = (cookies[port] || "") + sc.map(c => c.split(";")[0]).join("; ");
}
function getCookie(port) { return cookies[port] || ""; }

function api(method, port, pathStr, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const url = new URL(pathStr, "http://127.0.0.1:" + port);
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    const ck = getCookie(port);
    if (ck) headers["Cookie"] = ck;

    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers
    }, (res) => {
      saveCookies(port, res.headers);
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let pass = 0, fail = 0;
function check(name, ok) { if (ok) { pass++; console.log("  OK " + name); } else { fail++; console.log("  FAIL " + name); } }

async function run() {
  const P = { A: 4010, B: 4020, C: 4030 };
  const K = { A: "admin-key-a", B: "admin-key-b", C: "admin-key-c" };
  const CSRF = {};

  // Step 1
  console.log("\n=== 1. Login ===");
  for (const [n, port] of Object.entries(P)) {
    const r = await api("POST", port, "/api/login", { key: K[n] });
    CSRF[n] = r.data.csrf;
    check(n + " login:" + port, r.data.role === "admin");
  }

  // Step 2
  console.log("\n=== 2. A gen token ===");
  const sA = await api("GET", P.A, "/api/cluster/settings", null, { "X-CSRF-Token": CSRF.A });
  console.log("  nodeId:", sA.data.nodeId);
  console.log("  secret:", (sA.data.secret || "").substring(0, 16) + "...");
  console.log("  enabled:", sA.data.enabled);
  console.log("  token:", sA.data.shareToken ? sA.data.shareToken.substring(0, 50) + "..." : "NULL");
  console.log("  all keys:", Object.keys(sA.data).join(", "));

  const token = sA.data.shareToken;
  check("A token CDC02:", token && token.startsWith("CDC02:"));

  if (!token) {
    // Try again - first call auto-generates secret
    console.log("  Retry after auto-gen...");
    const sA2 = await api("GET", P.A, "/api/cluster/settings", null, { "X-CSRF-Token": CSRF.A });
    console.log("  retry token:", sA2.data.shareToken ? sA2.data.shareToken.substring(0, 50) + "..." : "NULL");
    console.log("  retry secret:", (sA2.data.secret || "").substring(0, 16) + "...");
    if (sA2.data.shareToken) {
      check("A token CDC02 (retry):", sA2.data.shareToken.startsWith("CDC02:"));
      if (sA2.data.shareToken) process.env.TOKEN_A = sA2.data.shareToken;
    }
    // Use retry token
    if (sA2.data.shareToken) {
      return runWithToken(CSRF, P, K, sA2.data.shareToken);
    }
    process.exit(1);
  }

  return runWithToken(CSRF, P, K, token);
}

async function runWithToken(CSRF, P, K, token) {
  // Step 3
  console.log("\n=== 3. B connect A ===");
  const cB = await api("POST", P.B, "/api/cluster/connect", { token }, { "X-CSRF-Token": CSRF.B });
  console.log("  result:", JSON.stringify(cB.data).substring(0, 120));
  check("B connect OK", cB.data.success);

  // Step 4
  console.log("\n=== 4. C connect A ===");
  const cC = await api("POST", P.C, "/api/cluster/connect", { token }, { "X-CSRF-Token": CSRF.C });
  check("C connect OK", cC.data.success);

  // Step 5: Peer status (互相确认)
  console.log("\n=== 5. Peer status (单向: B/C 看到 A) ===");
  for (const n of ["B", "C"]) {
    const peers = await api("GET", P[n], "/api/cluster/peers/status", null, { "X-CSRF-Token": CSRF[n] });
    console.log("  " + n + " peers:", JSON.stringify(peers.data).substring(0, 200));
    const online = (peers.data.peers || []).filter(p => p.online).length;
    check(n + " online:" + online, online > 0);
  }

  // Step 5b: 双向连接 — B/C 生成自己的口令，让 A 连接回来
  console.log("\n=== 5b. 双向互连 A<->B, A<->C ===");
  for (const n of ["B", "C"]) {
    const s = await api("GET", P[n], "/api/cluster/settings", null, { "X-CSRF-Token": CSRF[n] });
    const t = s.data.shareToken;
    check(n + " has token", !!t);
    const c = await api("POST", P.A, "/api/cluster/connect", { token: t }, { "X-CSRF-Token": CSRF.A });
    check("A connect " + n, c.data.success);
  }
  // 验证 A 现在有 2 个 peer
  const peersA = await api("GET", P.A, "/api/cluster/peers/status", null, { "X-CSRF-Token": CSRF.A });
  console.log("  A peers:", JSON.stringify(peersA.data).substring(0, 300));
  check("A has >=2 peers", (peersA.data.peers || []).length >= 2);

  // Step 6: A upload (A 是所有节点的对等节点，B/C 都能聚合到)
  console.log("\n=== 6. A upload file ===");
  const testFile = path.join(os.tmpdir(), "test_" + Date.now() + ".txt");
  fs.writeFileSync(testFile, "cluster-test-file-on-A");
  const uploadRes = await new Promise((resolve) => {
    const boundary = "----FB" + Math.random().toString(36).substring(2);
    const content = fs.readFileSync(testFile);
    const body = Buffer.concat([
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"test-on-A.txt\"\r\nContent-Type: text/plain\r\n\r\n"),
      content,
      Buffer.from("\r\n--" + boundary + "--\r\n")
    ]);
    const req = http.request({
      hostname: "127.0.0.1", port: P.A, path: "/api/upload", method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "X-CSRF-Token": CSRF.A, "Content-Length": body.length,
        "Cookie": getCookie(P.A)
      }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ error: d }); } });
    });
    req.write(body); req.end();
  });
  fs.unlinkSync(testFile);
  check("A upload OK", uploadRes.success);
  const fileKey = uploadRes.files?.[0]?.key;
  console.log("  file key:", fileKey);

  // Step 7: B 聚合文件列表（通过 A 的 peer 连接获取 A 的文件）
  console.log("\n=== 7. B aggregate file list (from A) ===");
  const filesB = await api("GET", P.B, "/api/files", null, { "X-CSRF-Token": CSRF.B });
  const namesB = (filesB.data.files || []).map(f => f.name);
  console.log("  files:", namesB.join(", "));
  console.log("  nodes:", JSON.stringify((filesB.data.nodes||[]).map(n=>n.nodeId+":"+n.fileCount+(n.error?" ERR:"+n.error:""))));
  check("B sees test-on-A.txt", namesB.includes("test-on-A.txt"));

  // Step 8: C 聚合文件列表
  console.log("\n=== 8. C aggregate file list (from A) ===");
  const filesC = await api("GET", P.C, "/api/files", null, { "X-CSRF-Token": CSRF.C });
  const namesC = (filesC.data.files || []).map(f => f.name);
  console.log("  files:", namesC.join(", "));
  check("C sees test-on-A.txt", namesC.includes("test-on-A.txt"));

  // Step 9: B 用 A 的文件密钥跨节点登录（B 有 A 为 peer）
  console.log("\n=== 9. B cross-node key login ===");
  if (fileKey) {
    const v = await api("POST", P.B, "/api/login", { key: fileKey });
    check("cross-node key lookup (B->A)", v.data.success && v.data.role === "viewer");
    console.log("  sourceNodeId:", v.data.sourceNodeId || "local", "file:", v.data.filename || "?");
    check("sourceNodeId is A", v.data.sourceNodeId === "node-shanghai");
  }

  // Step 10: full mesh
  console.log("\n=== 10. Full mesh B<->C ===");
  const sC = await api("GET", P.C, "/api/cluster/settings", null, { "X-CSRF-Token": CSRF.C });
  const tokenC = sC.data.shareToken;
  const cBC = await api("POST", P.B, "/api/cluster/connect", { token: tokenC }, { "X-CSRF-Token": CSRF.B });
  check("B connect C OK", cBC.data.success);
  const peersB2 = await api("GET", P.B, "/api/cluster/peers/status", null, { "X-CSRF-Token": CSRF.B });
  check("B has >=2 peers", (peersB2.data.peers || []).length >= 2);

  // End
  console.log("\n======== RESULT ========");
  console.log("PASS:", pass, " FAIL:", fail);
  console.log(fail === 0 ? "ALL PASS" : "SOME FAILED");
  return fail;
}

run().then(f => process.exit(f)).catch(e => { console.error(e.message); process.exit(1); });
