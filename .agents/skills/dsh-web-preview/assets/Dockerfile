# dsh web 运行时镜像（临时容器用；不含插件 —— 插件在挂载的 DSH_HOME 里）。
# dsh 版本与仓库 devDependency 对齐；升级时改这里的版本号重建。
FROM node:24-bookworm-slim

WORKDIR /opt/dsh-runtime
RUN npm install --no-audit --no-fund @deepseek-ai/dsh@0.2.1-alpha.5

COPY start.sh /opt/start.sh
RUN chmod 0755 /opt/start.sh

# /data = 挂载的开发 DSH_HOME（profile、patch 层、凭证、sessions 都持久化在宿主侧）。
ENV DSH_HOME=/data
EXPOSE 8377
ENTRYPOINT ["/opt/start.sh"]
