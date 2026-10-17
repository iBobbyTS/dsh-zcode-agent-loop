---
name: dsh-web-preview
description: 在临时容器里启动 dsh web（挂载固定开发 DSH_HOME、装载 zcode-loop 插件），提取带 token 的链接放进 final answer 交给用户验收。对应仓库 AGENTS.md「验收交付」规则的落地流程。
---

# dsh-web-preview：临时容器起 dsh web + 提取 token 链接

功能可验收后按本流程交付：**临时容器**跑服务（容器即弃），**开发 DSH_HOME 挂载持久化**（key/会话/配置跨次复用，模型 key 由用户在里面配，我们不预配）。

## 固定约定

| 组件 | 值 |
| --- | --- |
| 开发 DSH_HOME | `<repo>/.agent-work/dsh-home/`（git 已排除；每次复用同一路径） |
| 镜像 | `dsh-zcode-web-runtime`（node:24-slim + `npm install @deepseek-ai/dsh@<与仓库 devDependency 对齐>`；Dockerfile 在本 skill `assets/`） |
| 容器名 / 端口 | `zcode-loop-web`；宿主 `127.0.0.1:8391` → 容器 `8377` |
| skill 资产 | `scripts/prepare.mjs`（装插件+备 patch 层）、`assets/Dockerfile`、`assets/start.sh`（容器入口） |

prepare.mjs 做的事（幂等，可重跑）：esbuild 把 `dist/src/index.js` 打成单文件 bundle（`@deepseek-ai/*` external）→ 物化为 `<DSH_HOME>/profiles/web/node_modules/dsh-plugin-zcode-loop/`（每次刷新，保证与当前构建一致）→ 初始化 web profile（镜像 shipped 模板：dsh-base + dsh-web-app；已存在则不动用户层）→ 刷新 `<DSH_HOME>/patches/{repo.patch.yml,web-overlay.yml}`（repo 层 disable stock `agent-loop` + insert `zcode-loop`；overlay 层把插件行对齐 stock 默认路由 `deepseek-official/deepseek-flash`，不配任何凭证）。

## 流程

前置：`dist/` 是新鲜的（必要时先 `pnpm build`）；Colima 在跑。

```bash
# 1. 装插件进开发 DSH_HOME（幂等）
node .agents/skills/dsh-web-preview/scripts/prepare.mjs

# 2. 构建镜像（首次或 dsh 版本变更时；build 上下文用临时目录，不污染仓库）
T=$(mktemp -d) && cp .agents/skills/dsh-web-preview/assets/{Dockerfile,start.sh} "$T"/ \
  && (cd "$T" && docker build -q -t dsh-zcode-web-runtime .) && rm -rf "$T"

# 3. 起临时容器（--rm：停了即删；DSH_HOME 挂 /data 持久化）
docker rm -f zcode-loop-web 2>/dev/null
docker run -d --rm --name zcode-loop-web \
  -p 127.0.0.1:8391:8377 \
  -v "$PWD/.agent-work/dsh-home:/data" \
  -e DSH_PERMISSION_MODE=danger-full-access -e DSH_TELEMETRY_DISABLED=1 \
  dsh-zcode-web-runtime
# 宿主 shell 里有 DEEPSEEK_API_KEY 时可加 -e DEEPSEEK_API_KEY（优先级低于 home 内已存 key）

# 4. 提取带 token 的链接（start.sh 已 --public-url，链接直接可用）
docker logs zcode-loop-web 2>&1 | grep '^dsh web: http'
# → dsh web: http://127.0.0.1:8391/?token=...

# 5. 健康检查：token 换 cookie（期望 303 + Set-Cookie），跟随后 200 出 UI
curl -sL -c /tmp/c.txt -o /dev/null -w '%{http_code}\n' '<上一步的链接>'
```

通过后把链接放进 final answer。

## 交付话术要点

- 链接一次一 token；GET / 带 token 会铸造 30 天 HttpOnly cookie（SameSite=Strict）。
- 模型 key 配置（用户自助，热加载无需重启）：web UI 的 **Models 页**（写入 `$DSH_HOME/.credentials.yaml`）；或 `$DSH_HOME/.env` 里 `DEEPSEEK_API_KEY=...`。优先级：`.credentials.yaml` > 容器注入的进程环境 > `<cwd>/.env` > `$DSH_HOME/.env`。
- 停止：`docker rm -f zcode-loop-web`（数据都在挂载的 DSH_HOME，下次起容器继续用）。

## 原理备忘（排障用）

- `dsh web` 的 `--host` **拒绝通配地址**（0.0.0.0），容器内必须绑自己的具体 IPv4 —— `start.sh` 用 node `os.networkInterfaces()` 取 eth0 地址；端口经 docker 发布映射到宿主。
- `--public-url http://127.0.0.1:8391` 让启动行打出的 URL 直接是宿主可达形态（不用改写容器 IP）；浏览器信任栅栏（/api browser-trust fence）需要 `--trusted-host 127.0.0.1:8391`（及 `localhost:8391`）。
- native 依赖（node-pty、koffi、node-addon-*）在 linux-arm64 均有 prebuilt，镜像无需编译工具链；`dsh-subprocess-local` 的 postinstall 只是 chmod。
- 验证插件行生效：`docker exec zcode-loop-web node /opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --patch /data/patches/repo.patch.yml --patch /data/patches/web-overlay.yml --dump-config` 应看到 `agent-loop ... disabled: true` 与插入的 `zcode-loop` 行。
- 升级 dsh：改 `assets/Dockerfile` 里的版本号 + 重建镜像（版本对齐仓库 devDependency `@deepseek-ai/dsh`）。
