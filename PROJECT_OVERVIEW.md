# 分布式云盘 v2.3.1 项目全览

> 最后更新：2026-06-27 · 开启新对话时阅读本文档即可了解全部上下文

---

## 一、项目概述

**文件中转站 (cloud-drive)** — 轻量级私有文件分享服务，支持单机独立运行和多节点对等网格集群。

- GitHub：`https://github.com/tianshiemo7/cloud-drive`
- 运行环境：Node.js 18+ / Express / 零数据库（纯 JSON 文件持久化）
- 部署方式：PM2 进程守护 + Nginx 反向代理

---

## 二、服务器状态

| 项目 | 值 |
|------|-----|
| 公网 IP | `106.15.92.8` |
| 云盘地址 | `http://106.15.92.8/cloud/` |
| 端口 | 3002（内部）/ 80（Nginx 反代） |
| PM2 进程名 | `cloud-drive` |
| 管理员密钥 | `cloud2024` |
| 当前模式 | 独立模式（未配置对等节点） |
| 文件数量 | 9 个 |
| SSH | `ssh -i C:\Users\刘朝阳\.ssh\keepfit_key root@106.15.92.8` |

---

## 三、文件结构

```
/www/wwwroot/cloud-drive/
├── server.js              # 主入口（组装模块、路由挂载、启动迁移）
├── server.js.backup       # v2.0.1 旧版备份
├── package.json           # 依赖：express, express-session, multer
├── .env                   # 环境变量（管理员密钥、集群配置）
├── .env.example           # 配置模板
├── ecosystem.config.js    # PM2 配置
├── keys.json              # 文件元数据（密钥/有效期/下载次数/MD5/folder）
├── folders.json           # 虚拟文件夹树
├── snippets.json          # 文本片段
├── cluster-config.json    # 运行时集群配置（可选，API 写入）
├── uploads/               # 文件物理存储
├── snippets/              # 片段存储
├── logs/                  # PM2 日志
├── lib/
│   ├── config.js          # 配置加载（.env + process.env）
│   ├── utils.js           # 工具函数（限速器、safePath、multer）
│   ├── persistence.js     # 数据持久化（keys/snippets/folders 读写、过期清理）
│   ├── auth.js            # 认证模块（登录/登出/CSRF/权限中间件）
│   ├── files.js           # 文件管理（上传/下载/预览/删除/移动/密钥重置）
│   ├── snippets.js        # 文本片段
│   ├── folders.js         # 文件夹 CRUD（创建/删除/重命名/聚合）
│   ├── cluster.js         # 集群通信（HMAC签名/对等请求/文件聚合/代理流/拓扑发现）
│   └── cluster-config.js  # 运行时集群配置管理（读写 cluster-config.json）
└── public/
    ├── index.html         # SPA 前端（登录页/管理面板/设置抽屉/树形侧栏/文件网格）
    ├── app.js             # 前端逻辑（~800行：认证/树组件/文件网格/设置面板/集群管理）
    ├── style.css          # 响应式样式（暗色模式/树形视图/设置面板/文件网格）
    ├── manifest.json      # PWA 清单
    └── sw.js              # Service Worker
```

---

## 四、核心功能

### 4.1 文件管理
- 多文件上传（最多 20 个，单个 500MB）
- 图片/视频/音频在线预览
- 文件分享密钥（6 位 hex，支持有效期/下载次数/阅后即焚）
- MD5 校验、二维码分享
- 拖拽上传、剪贴板粘贴、拍照上传

### 4.2 文件夹感知上传（v2.3.1）
- 上传文件时自动归属到当前浏览的文件夹（不再始终上传到根目录）
- 支持拖拽/粘贴/拍照等多种上传方式，全部携带文件夹上下文
- 文件夹删除后文件自动移回节点根目录
- moveFile API 增加目标文件夹存在性验证

### 4.3 安全加固（v2.3.1）
- **XSS 防护**：`escapeAttr` 增加反斜杠转义和 HTML 实体编码，防止属性注入
- **原型链绕过**：文件夹验证使用 `Object.hasOwn()`，防止 `__proto__` 等特殊键绕过
- **CSRF 增强**：移除 session.csrf falsy 时的静默放行缺陷
- **会话安全**：管理员登录时 regenerate session，防止会话固定
- **路径穿越**：rekeyHandler 使用 `safePath` 防御
- **上传限速**：30 次/5 分钟，防止磁盘填满攻击
- **性能优化**：持久层内存缓存（减少每次请求的磁盘 I/O），密钥生成优化

### 4.4 树形文件系统（v2.2.0）
- 左侧可折叠目录树，每个集群节点是一个根文件夹
- 虚拟文件夹：创建/重命名/删除/嵌套，不影响物理存储
- 面包屑导航，点击跳转
- 文件卡片网格展示，标注存储节点来源

### 4.5 设置面板（v2.2.0）
- ⚙ 左上角齿轮按钮打开
- **节点信息**：查看节点 ID/名称/版本/磁盘/运行时间
- **📋 分享连接**：一键复制连接信息（文本/JSON/二维码），对方粘贴即可接入
- **集群设置**：添加/移除对等节点、粘贴分享信息、预览拓扑
- **管理员设置**：修改节点名称

### 4.6 集群互联（v2.1.0+）
- HMAC-SHA256 请求签名（防重放，5 分钟时间窗口）
- 文件列表跨节点聚合
- 文件下载/预览流式代理（不落盘）
- 跨节点密钥查找（在 A 用 B 的文件密钥登录）

---

## 五、固定连接信息（分享用）

部署时已在 `.env` 中写死，不会变化：

```
节点ID: node-shanghai
节点名称: 上海主节点
地址: http://106.15.92.8:3002
密钥: ee5301918f1e2fc559eacb14dab78c6763dbd88b210b08c0c44b9e1ec3784e1f
```

对方收到后 → 设置 → 集群设置 → 粘贴分享信息 → 自动填入 → 添加节点。

---

## 六、API 路由一览

### 用户 API
| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/login` | 限速 | 密钥登录 |
| POST | `/api/logout` | — | 登出 |
| GET | `/api/check` | — | 检查登录状态 |
| GET | `/api/files` | requireAuth | 文件列表（集群模式自动聚合） |
| POST | `/api/upload` | admin+CSRF | 上传文件 |
| GET | `/api/download/:filename` | requireAuth | 下载（支持远程代理） |
| GET | `/api/preview/:filename` | requireAuth | 预览（支持远程代理） |
| DELETE | `/api/files/:filename` | admin+CSRF | 删除 |
| POST | `/api/files/delete-batch` | admin+CSRF | 批量删除 |
| POST | `/api/files/:filename/rekey` | admin+CSRF | 重置密钥 |
| PUT | `/api/files/:name/move` | admin+CSRF | 移动文件到文件夹 |
| GET | `/api/disk` | admin | 磁盘使用 |
| GET | `/api/health` | — | 健康检查 |

### 文件夹 API
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/folders` | 列出文件夹树（集群模式自动聚合） |
| POST | `/api/folders/create` | 创建文件夹 `{name, parent?, nodeId?}` |
| DELETE | `/api/folders/:id` | 删除空文件夹 |
| PUT | `/api/folders/:id/rename` | 重命名文件夹 |

### 集群设置 API
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cluster/settings` | 读取配置（含 shareInfo/shareText） |
| PUT | `/api/cluster/settings` | 更新配置 |
| POST | `/api/cluster/peers` | 添加对等节点 |
| DELETE | `/api/cluster/peers/:nodeId` | 移除对等节点 |
| GET | `/api/cluster/peers/status` | 对等节点在线状态 |
| POST | `/api/cluster/discover` | 拓扑发现 |

### 内部 API（节点间 HMAC 签名通信）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/internal/ping` | 健康检查 |
| GET | `/api/internal/peers` | 本节点对等列表（拓扑发现用） |
| GET | `/api/internal/files` | 本节点文件列表 |
| POST | `/api/internal/lookup-key` | 按密钥查找文件 |
| GET | `/api/internal/file/:fn/download` | 流式传输文件 |
| GET | `/api/internal/file/:fn/preview` | 流式传输预览 |
| GET | `/api/internal/folders` | 本节点文件夹列表 |
| GET | `/api/internal/disk` | 磁盘信息 |

---

## 七、集群通信协议

### HMAC 签名头
```
X-Cluster-NodeId: node-shanghai
X-Cluster-Timestamp: 1751548800
X-Cluster-Nonce: <random-16-byte-hex>
X-Cluster-Signature: <base64(HMAC-SHA256(secret, "METHOD\nPATH\nTIMESTAMP\nNONCE"))>
```

### 配置文件优先级
1. `cluster-config.json`（API 写入，运行时修改）
2. `.env` 文件（部署时写入）
3. `process.env`（PM2 ecosystem.config.js）
4. 默认值（自动检测 IP）

### 启动迁移
服务器启动时自动执行：
- 如果 `folders.json` 有旧根文件夹（不同 nodeId），自动重命名为当前 nodeId
- 如果没有根文件夹，创建一个
- 把 `folder: null` 或 `folder` 指向不存在节点的文件迁移到当前根文件夹

---

## 八、已知问题和注意事项

1. **Session 存储**：使用内存存储，PM2 重启后所有 session 失效（用户需重新登录）
2. **并发写入**：`keys.json` 使用同步写，高并发下可能丢失数据
3. **文件密钥强度**：6 位 hex（~1600 万组合），有登录限速保护（5 分钟 10 次）和上传限速（5 分钟 30 次）
4. **PM2 版本号**：PM2 面板显示的版本号取自 `package.json`（2.0.1），实际运行 v2.3.1
5. **`.env` 读取**：`config.js` 的 `getEnv()` 同时读 `process.env` 和 `.env` 文件，`process.env` 优先
6. **PORT 配置**：`config.js` 从 `.env` 读取 PORT，但 PM2 的 `ecosystem.config.js` 优先级更高
7. **缓存一致性**：persistence 层有内存缓存，外部修改 keys.json/folders.json 需重启生效

---

## 九、常用运维命令

```bash
# 登录
ssh -i C:\Users\刘朝阳\.ssh\keepfit_key root@106.15.92.8

# 重启云盘
pm2 restart cloud-drive --update-env

# 查看日志
pm2 logs cloud-drive --lines 20 --nostream

# 查看状态
pm2 status

# 更新代码（从本机上传）
scp -i C:\Users\刘朝阳\.ssh\keepfit_key -o StrictHostKeyChecking=no \
  cloud-drive/server.js cloud-drive/lib/*.js root@106.15.92.8:/www/wwwroot/cloud-drive/lib/
scp -i C:\Users\刘朝阳\.ssh\keepfit_key -o StrictHostKeyChecking=no \
  cloud-drive/server.js cloud-drive/public/app.js cloud-drive/public/style.css \
  root@106.15.92.8:/www/wwwroot/cloud-drive/
# 然后 pm2 restart cloud-drive --update-env
```

---

## 十、GitHub 仓库

- 地址：`https://github.com/tianshiemo7/cloud-drive`
- 当前版本：v2.3.1
- `.gitignore` 排除：`node_modules/` `uploads/` `.env` `keys.json` `snippets.json` `server.js.backup`

---

## 十一、Changelog

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.0.1 | 2026-06-27 | 单机版：Express + multer + session |
| v2.1.0 | 2026-06-27 | 模块化拆分 `lib/` + HMAC 集群通信 + 跨节点代理 |
| v2.2.0 | 2026-06-27 | 树形文件系统 + 设置面板 + 文件夹 CRUD + 拓扑发现 + 一键分享 |
| v2.3.0 | 2026-06-27 | 一键连接口令（粘贴即连接，无需重启） |
| v2.3.1 | 2026-06-27 | 🔒 安全审计修复：XSS/原型链绕过/CSRF/会话固定/路径穿越/上传限速/持久层缓存 + 📁 文件夹感知上传 + moveFile 验证 |
