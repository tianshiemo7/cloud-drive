# 分布式云盘部署指南 — 从零到集群互联

> 适用版本：v2.1.0  
> GitHub：https://github.com/tianshiemo7/cloud-drive  
> 前置要求：一台带公网 IP 的 Linux 服务器（推荐阿里云 ECS）

---

## 目录

1. [准备工作](#1-准备工作)
2. [单机部署（5 分钟）](#2-单机部署)
3. [测试单机功能](#3-测试单机功能)
4. [配置集群互联](#4-配置集群互联)
5. [测试集群功能](#5-测试集群功能)
6. [连接到我已有的云盘](#6-连接到我已有的云盘)
7. [常用运维](#7-常用运维)
8. [回滚方案](#8-回滚方案)

---

## 1. 准备工作

### 1.1 你需要的信息

| 项目 | 说明 |
|------|------|
| 一台 Linux 服务器 | 推荐 2 vCPU / 2 GiB 以上，有公网 IP |
| 你的服务器公网 IP | 如 `123.45.67.89` |
| 域名（可选） | 后续可绑定 |
| 现有节点信息 | 如果要连接到已有集群（见第 6 节） |

### 1.2 安装 Node.js 18+

```bash
# Alibaba Cloud Linux / CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# 验证
node -v   # 应输出 v18.x.x
npm -v    # 应输出 9.x.x 或 10.x.x
```

### 1.3 安装 PM2（进程守护）

```bash
npm install -g pm2
pm2 startup   # 设置开机自启，按提示执行输出命令
```

### 1.4 安装 Nginx（可选，推荐）

```bash
yum install -y nginx    # CentOS/RHEL
apt-get install -y nginx  # Ubuntu/Debian
```

---

## 2. 单机部署

### 2.1 克隆代码

```bash
git clone https://github.com/tianshiemo7/cloud-drive.git
cd cloud-drive
```

### 2.2 安装依赖

```bash
npm install
```

### 2.3 创建配置文件

```bash
# 从模板创建 .env
cp .env.example .env
```

编辑 `.env`：

```bash
nano .env
```

内容如下：

```env
# 设置你自己的管理员密钥（这很重要！）
CLOUD_DRIVE_ADMIN_KEY=你的强密码_至少16位

# 单机模式：不需要填以下内容
# CLUSTER_NODE_ID=
# CLUSTER_PEERS=
```

> ⚠️ `CLOUD_DRIVE_ADMIN_KEY` 是你登录管理后台的密码，必须设置一个强密码。  
> 如果不设置，系统会自动生成一个 8 位随机密钥并打印在启动日志中。

### 2.4 创建必要目录

```bash
mkdir -p uploads snippets logs
```

### 2.5 启动服务

**方式一：直接运行（测试用）**

```bash
node server.js
```

看到以下输出表示成功：

```
📁  文件中转站 v2.1.0 已启动
   地址: http://127.0.0.1:3002
   管理员密钥: 你的密码
   存储目录: .../uploads
   模式: 独立运行
```

按 `Ctrl+C` 停止。

**方式二：PM2 守护运行（生产用）**

```bash
pm2 start ecosystem.config.js
pm2 save
```

### 2.6 配置 Nginx 反向代理（推荐）

复制项目中的 `keep-fit.conf` 到 Nginx 配置目录，或创建新配置：

```bash
nano /etc/nginx/conf.d/cloud-drive.conf
```

```nginx
server {
    listen 80;
    server_name _;    # 有域名则改为你的域名

    client_max_body_size 500m;

    # 安全头
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://127.0.0.1:3002;
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
# 测试配置
nginx -t

# 重载
nginx -s reload
```

### 2.7 开放防火墙端口

**阿里云控制台** → 服务器实例 → 防火墙 → 添加规则：

| 端口 | 来源 | 用途 |
|------|------|------|
| 80 | 0.0.0.0/0 | HTTP 访问 |
| 3002 | 集群对等节点 IP | 节点间通信（集群模式才需要） |

---

## 3. 测试单机功能

### 3.1 浏览器访问

打开 `http://你的公网IP/`（或带子路径 `http://你的公网IP/cloud/`）

### 3.2 登录

输入你在 `.env` 中设置的 `CLOUD_DRIVE_ADMIN_KEY`。

### 3.3 测试上传和下载

- 拖拽/点击上传文件
- 生成密钥分享链接
- 下载/预览文件

### 3.4 API 健康检查

```bash
curl http://你的IP:3002/api/health
```

预期返回：

```json
{"status":"ok","version":"2.1.0","files":0,...}
```

---

## 4. 配置集群互联

当你有多台服务器时，让它们组成对等网格。

### 4.1 生成共享密钥

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

输出类似：`d7f3a1b8c2e4...64位hex...`

**这个密钥在所有节点间必须完全一致。** 记下它，下面用 `<SHARED_SECRET>` 表示。

### 4.2 配置每台服务器

以两台服务器为例：

**服务器 A（节点1）：**

```bash
nano .env
```

```env
CLOUD_DRIVE_ADMIN_KEY=服务器A的管理员密码

# 节点身份
CLUSTER_NODE_ID=node-1
CLUSTER_NODE_NAME=节点一

# 共享密钥（所有节点必须一致）
CLUSTER_SECRET=<SHARED_SECRET>

# 对等节点列表（列出除自己之外的所有节点）
# 格式: 节点ID::http://IP:3002::共享密钥
CLUSTER_PEERS=node-2::http://<服务器B的IP>:3002::<SHARED_SECRET>
```

**服务器 B（节点2）：**

```bash
nano .env
```

```env
CLOUD_DRIVE_ADMIN_KEY=服务器B的管理员密码

CLUSTER_NODE_ID=node-2
CLUSTER_NODE_NAME=节点二

CLUSTER_SECRET=<SHARED_SECRET>

CLUSTER_PEERS=node-1::http://<服务器A的IP>:3002::<SHARED_SECRET>
```

### 4.3 重启所有节点

```bash
# 每台服务器上都执行
pm2 restart cloud-drive
pm2 save
```

启动日志中应看到：

```
🌐 集群模式已启用 · 节点: node-1 · 对等节点: node-2
```

### 4.4 防火墙配置（关键！）

在每台服务器的防火墙/安全组中，**允许其他对等节点的 IP 访问端口 3002**。

> ⚠️ 端口 3002 不应对外开放（0.0.0.0/0），只开放给对等节点的 IP。

---

## 5. 测试集群功能

### 5.1 验证节点互通

在服务器 A 上：

```bash
# 检查服务器 B 的内部 API
curl -H "X-Cluster-NodeId: node-1" \
     -H "X-Cluster-Timestamp: $(date +%s)" \
     -H "X-Cluster-Nonce: test123" \
     -H "X-Cluster-Signature: test" \
     http://<服务器B的IP>:3002/api/internal/ping
```

### 5.2 跨节点文件访问

1. 在服务器 B 的管理页面上传一个文件
2. 复制文件密钥
3. 打开服务器 A 的管理页面
4. 你应该能在文件列表中看到来自服务器 B 的文件（带有 `🖥 node-2` 标签）
5. 在服务器 A 的页面上可以直接预览/下载服务器 B 的文件

### 5.3 跨节点密钥登录

1. 在服务器 B 上生成一个文件分享密钥
2. 在服务器 A 的登录页输入该密钥
3. 应能成功登录为 viewer 并访问远程文件

---

## 6. 连接到我已有的云盘

我的云盘运行在 `106.15.92.8:3002`，集群配置如下。

### 6.1 需要我提供的信息

我会通过安全渠道发给你：

| 参数 | 用途 |
|------|------|
| 共享密钥 `CLUSTER_SECRET` | HMAC 签名用 |
| 节点 ID | `node-shanghai` |
| 节点名称 | `上海主节点` |
| IP:端口 | `106.15.92.8:3002` |

### 6.2 你的 .env 配置

```env
CLOUD_DRIVE_ADMIN_KEY=你自己设的管理员密码

CLUSTER_NODE_ID=node-beijing    # 改成你自己的节点名
CLUSTER_NODE_NAME=北京节点       # 自定义名称

CLUSTER_SECRET=<我发给你的共享密钥>

CLUSTER_PEERS=node-shanghai::http://106.15.92.8:3002::<共享密钥>
CLUSTER_TIMEOUT=5000
```

### 6.3 你的防火墙配置

在阿里云控制台添加出方向/入方向规则：

| 方向 | 端口 | IP |
|------|------|-----|
| 入方向 | 3002 | 106.15.92.8 |
| 出方向 | — | 106.15.92.8:3002 |

### 6.4 我的防火墙配置

我这边会添加你的服务器 IP 到端口 3002 的入方向规则。

### 6.5 重启生效

```bash
pm2 restart cloud-drive
```

启动后，打开你的管理页面，应能在文件列表中看到来自 `🖥 node-shanghai` 的文件。

---

## 7. 常用运维命令

```bash
# 查看服务状态
pm2 status

# 查看日志（实时）
pm2 logs cloud-drive

# 查看日志（最近 50 行）
pm2 logs cloud-drive --lines 50 --nostream

# 重启
pm2 restart cloud-drive

# 停止
pm2 stop cloud-drive

# 保存进程列表
pm2 save

# 系统资源
df -h       # 磁盘使用
free -h     # 内存使用

# 更新代码
cd /www/wwwroot/cloud-drive
git pull
npm install --production
pm2 restart cloud-drive
```

---

## 8. 回滚方案

```bash
cd /www/wwwroot/cloud-drive

# 替换为旧版
cp server.js.backup server.js
rm -rf lib/

# 重启
pm2 restart cloud-drive
```

---

## 附录 A：端口一览

| 端口 | 用途 | 对外？ |
|------|------|--------|
| 80 | Nginx → 反代到 3002 | ✅ 公网 |
| 443 | HTTPS（如有证书） | ✅ 公网 |
| 3002 | Node 直连 + 对等节点通信 | ❌ 仅对等节点 |
| 22 | SSH | ✅ 公网 |

## 附录 B：架构速览

```
┌──────────────┐    HMAC 签名     ┌──────────────┐
│  节点 A       │◄──────────────►│  节点 B       │
│  (上海)       │   /api/internal/  │  (北京)       │
│  uploads/    │                  │  uploads/    │
└──────┬───────┘                  └──────┬───────┘
       │                                 │
       │  Nginx :80                      │  Nginx :80
       │                                 │
   用户浏览器 ←── 从A访问B的文件时A代理流 ──→
```

- 文件始终存储在上传节点，不做复制
- 下载/预览时通过 HTTP pipe 流式代理
- 前端始终只和本节点通信，后端透明代理远程文件
