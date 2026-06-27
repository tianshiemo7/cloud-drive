FROM node:18-alpine

# 安装 dumb-init 用于优雅关闭
RUN apk add --no-cache dumb-init

WORKDIR /app

# 依赖层
COPY package.json ./
RUN npm install --production

# 应用代码
COPY . .

# 创建必要目录
RUN mkdir -p uploads snippets logs

# 安全：非 root 运行
RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app
RUN chown -R app:app /app
USER app

EXPOSE 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
