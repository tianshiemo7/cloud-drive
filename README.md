# 📁 文件中转站 (FileRelay)

手机与电脑之间的文件互传工具，支持密钥分享、阅后即焚、文本片段。

## 特性

### 文件管理
- **多文件上传** — 拖拽/选择/剪贴板粘贴，单文件最大 500MB，一次最多 20 个
- **文件预览** — 图片、视频、音频可直接在浏览器中预览
- **排序与搜索** — 按名称/大小/日期排序，实时搜索过滤
- **批量操作** — 勾选多个文件 → 批量删除

### 密钥系统
- **管理员密钥** — 全权限，登录后设备信任（Session 有效期 1 年）
- **文件专属密钥** — 每个文件自动生成 6 位密钥，可分享给他人
- **有效期** — 设置密钥在 1小时/24小时/7天/30天 后自动过期
- **阅后即焚** — 下载 1 次后自动删除文件
- **下载次数限制** — 限制 1/5/10/100 次下载
- **自动清理** — 每小时检查并清理过期文件

### 分享方式
- 复制密钥或完整链接一键分享
- 生成二维码，手机扫码直接访问
- URL 参数直达：`http://your-server/cloud/?key=xxxxx`

### 文本片段
- 粘贴文本 → 生成分享链接（类 Pastebin）
- 支持 `?snippet=xxxxx` 参数自动展示

### 安全
- 登录限速（5分钟内10次，防暴力破解）
- 管理员密钥首次启动自动随机生成
- CSRF Token 保护变更类请求
- 目录穿越防护
- Nginx 安全头（X-Content-Type-Options / X-Frame-Options / X-XSS-Protection）

### 体验
- 响应式设计，手机/PC 通用
- 自动暗色模式（跟随系统 / 手动切换）
- PWA — 可添加到手机主屏幕
- 右键快捷菜单
- 📷 拍照直接上传
- 剪贴板图片粘贴上传

---

## 部署

### 环境要求
- Node.js 18+
- Nginx（可选，推荐）
- PM2（可选，推荐）

### 快速启动

```bash
# 安装依赖
npm install

# 设置管理员密钥（可选，不设则自动生成）
echo "CLOUD_DRIVE_ADMIN_KEY=你的密钥" > .env

# 启动
node server.js
# → http://localhost:3002
```

### PM2 部署（推荐）

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

日志自动轮转：单文件 10MB，保留 7 天。

### Nginx 反代

```nginx
location /cloud/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 500m;
}
```

### Docker

```bash
docker compose up -d
# → http://localhost:3002
```

---

## 使用

### 管理员
1. 打开网页，输入管理员密钥登录
2. 上传文件 → 每个文件自动生成 6 位密钥
3. 点击 📋 复制密钥 或 🔗 复制链接发给他人
4. 点 ⚙ 可设置过期时间、阅后即焚、下载次数

### 文件接收者
1. 打开收到的链接（或输入文件密钥）
2. 只能看到和下载该文件
3. 受密钥设置限制（过期/次数/阅后即焚）

---

## API

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/login` | 限速 | 登录（`{key}`） |
| POST | `/api/logout` | — | 登出 |
| GET | `/api/check` | — | 检查登录状态 |
| GET | `/api/files` | 登录 | 文件列表 |
| POST | `/api/upload` | 管理员+CSRF | 上传（`FormData`） |
| GET | `/api/download/:name` | 登录 | 下载文件 |
| DELETE | `/api/files/:name` | 管理员+CSRF | 删除文件 |
| POST | `/api/files/delete-batch` | 管理员+CSRF | 批量删除 |
| POST | `/api/files/:name/rekey` | 管理员+CSRF | 重置密钥/设置选项 |
| GET | `/api/preview/:name` | 登录 | 预览（图片/视频/音频流） |
| GET | `/api/disk` | 管理员 | 磁盘使用 |
| GET | `/api/health` | — | 健康检查 |
| POST | `/api/snippets` | 管理员+CSRF | 创建文本片段 |
| GET | `/api/snippets/:key` | — | 获取文本片段 |

---

## 文件结构

```
├── server.js              # Express 主服务
├── package.json
├── ecosystem.config.js    # PM2 配置（环境变量 + 日志轮转）
├── Dockerfile
├── docker-compose.yml
├── .env                   # CLOUD_DRIVE_ADMIN_KEY
├── keys.json              # 文件元数据（自动生成）
├── snippets.json          # 文本片段（自动生成）
├── public/
│   ├── index.html         # SPA 前端
│   ├── style.css          # 响应式 + 暗色模式
│   ├── app.js             # 前端逻辑
│   ├── manifest.json      # PWA 清单
│   └── sw.js              # Service Worker
├── uploads/               # 文件存储
├── snippets/              # 片段存储
└── logs/                  # PM2 日志
```

---

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CLOUD_DRIVE_ADMIN_KEY` | 自动生成 | 管理员密钥（8位十六进制） |

首次启动时如未设置，会自动生成并写入 `.env` 文件。通过 PM2 部署时建议在 `ecosystem.config.js` 中配置。

---
