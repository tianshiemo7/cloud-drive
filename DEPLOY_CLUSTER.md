# 分布式云盘部署指南 — 从零到集群互联

> 适用版本：v2.3.0（一键连接口令）  
> GitHub：https://github.com/tianshiemo7/cloud-drive  
> 前置要求：一台带公网 IP 的 Linux 服务器

---

## 目录

1. [准备工作](#1-准备工作)
2. [单机部署（3 分钟）](#2-单机部署)
3. [测试单机功能](#3-测试单机功能)
4. [集群互联 — 一键连接](#4-集群互联--一键连接)
5. [连接到我已有的云盘](#5-连接到我已有的云盘)
6. [常用运维](#6-常用运维)
7. [附件](#7-附件)

---

## 1. 准备工作

| 项目 | 说明 |
|------|------|
| Linux 服务器 | 推荐 2 vCPU / 2 GiB，有公网 IP |
| Node.js 18+ | 见下方安装命令 |
| PM2 | 进程守护 |
| Nginx（推荐） | 反向代理 |

### 安装 Node.js 18+

```bash
# Alibaba Cloud Linux / CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# 验证
node -v   # v18.x.x
```

### 安装 PM2

```bash
npm install -g pm2
pm2 startup
```

---

## 2. 单机部署

```bash
git clone https://github.com/tianshiemo7/cloud-drive.git
cd cloud-drive
npm install
cp .env.example .env
nano .env          # 设置 CLOUD_DRIVE_ADMIN_KEY=你的强密码
mkdir -p uploads snippets logs
pm2 start ecosystem.config.js
pm2 save
```

### Nginx 反向代理（推荐）

```nginx
server {
    listen 80;
    server_name _;
    client_max_body_size 500m;

    # Service Worker — 禁止缓存
    location = /cloud/sw.js {
        proxy_pass http://127.0.0.1:3002/sw.js;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location /cloud/ {
        proxy_pass http://127.0.0.1:3002/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

```bash
nginx -t && nginx -s reload
```

### 防火墙

阿里云控制台 → 防火墙 → 添加规则：

| 端口 | 来源 | 用途 |
|------|------|------|
| 80 | 0.0.0.0/0 | HTTP |
| 3002 | 对等节点 IP | 集群通信 |

---

## 3. 测试单机功能

```bash
# 健康检查
curl http://你的IP/cloud/api/health
# → {"status":"ok","files":0,"version":"2.2.0"}

# 浏览器访问
http://你的IP/cloud/
```

登录密钥即 `.env` 中设置的 `CLOUD_DRIVE_ADMIN_KEY`。

---

## 4. 集群互联 — 一键连接

**v2.3.0 新增：无需编辑 .env，无需重启，复制粘贴即可。**

### 4.1 云盘 A：生成连接口令

1. 登录 A 的管理页面
2. 点左上角 ⚙ → **节点信息**
3. 点 **📋 复制连接口令**

> 首次点击会自动生成 64 位 `CLUSTER_SECRET` 并写入 `.env`。口令格式：`CDC02:eyJ...`

### 4.2 云盘 B：粘贴连接

1. 登录 B 的管理页面
2. 点 ⚙ → **集群设置**
3. 在 **🔗 一键连接** 输入框中粘贴口令
4. 点 **连接**

**即时生效，无需重启。** B 的文件列表将自动聚合 A 的文件（带 `🖥节点标签`）。

### 4.3 双向互联

A 也需要连回 B 才能双向互通。B 同样生成自己的口令 → A 粘贴连接。

```
┌──────────────┐     CDC02 口令      ┌──────────────┐
│   云盘 A      │ ◄──────────────► │   云盘 B      │
│  node-shanghai│   互相粘贴连接      │  node-beijing │
│  uploads/    │                   │  uploads/    │
└──────────────┘                   └──────────────┘
```

### 4.4 防火墙

每台服务器的 **端口 3002** 需要对所有对等节点 IP 开放（不要开放给 0.0.0.0/0）。

---

## 5. 连接到我已有的云盘

我的云盘：`http://106.15.92.8:3002`（节点 `node-shanghai` / 上海主节点）

### 你需要做的

1. 部署你自己的云盘（按第 2 节）
2. 我生成连接口令发给你 → 你在集群设置中粘贴 → 连接
3. 我同样粘贴你的口令 → 双向互通

### 我需要做的

- 在阿里云防火墙中将你的 IP 加入端口 3002 的入方向白名单

---

## 6. 常用运维

```bash
# 查看服务
pm2 status

# 查看日志
pm2 logs cloud-drive --lines 50

# 重启
pm2 restart cloud-drive

# 更新代码
cd /www/wwwroot/cloud-drive
git pull
npm install --production
pm2 restart cloud-drive

# 健康检查
curl http://127.0.0.1:3002/api/health

# 磁盘/内存
df -h && free -h
```

---

## 7. 附件

### 端口一览

| 端口 | 用途 | 对外 |
|------|------|------|
| 80 | Nginx → 3002 | ✅ 公网 |
| 3002 | Node + 对等节点通信 | ❌ 仅对等节点 IP |

### 口令格式

```
CDC02:base64url({"n":"节点ID","m":"名称","a":"http://IP:端口","s":"共享密钥"})
```

- 兼容旧版多行分享文本和 JSON 格式
- `CLUSTER_SECRET` 首次生成时自动创建并持久化

### 架构

```
┌──────────────┐   HMAC-SHA256    ┌──────────────┐
│   节点 A      │◄──────────────►│   节点 B      │
│  uploads/    │  /api/internal/  │  uploads/    │
└──────┬───────┘                  └──────┬───────┘
       │ Nginx :80                       │ Nginx :80
       │                                 │
   用户浏览器 ←── HTTP pipe 流代理 ──→
```

- 文件始终存储在上传节点，不复制
- 跨节点下载/预览通过 HTTP pipe 流式代理
- 前端只和本节点通信，后端透明代理远程文件
- `verifySignature` 支持"共享密钥信任"模式，任何持有正确密钥的节点均可加入网格
