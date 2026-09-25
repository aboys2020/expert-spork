# 使用官方 Node.js 镜像作为基础镜像
# 注意：Node 18 已不被 Vite 8 支持（要求 20.19+ / 22.12+），这里同步抬到 20
FROM node:20-slim

# 设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 复制整个项目到容器内
COPY . .

# 暴露容器的 3000 端口
EXPOSE 3000

# 设置容器启动时运行的命令
CMD ["npm", "start"]
