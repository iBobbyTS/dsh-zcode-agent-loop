# zcode-loop-prototype — 把 ZCode AgentRuntime 嵌进真实 dsh 的原型

本仓库把 vendored ZCode `AgentRuntime`（`vendor/zcode/` 快照 v3.15.1）作为一个
**外部 dsh 插件**（`src/` → `dsh-plugin-zcode-loop`）装进**独立从 npm 拉取的真实
dsh**（devDependency `@deepseek-ai/dsh`），替换其自带 `dsh-agent-loop`，不改 dsh
与 `reference/` 一字。

对话路径（全部真实 dsh 形态）：

```
用户输入 → dsh inbox（ZcodeLoopInbox）→ ZCode 引擎驱动模型请求
  → model-bridge → dsh llm 路由（provider adapter）→ 模型发起工具调用
  → tool-bridge → dsh ToolRuntime 管线（pre-execute waterfall → 执行 → post-execute）
  → 结果回填引擎 → 引擎结束 turn
  → dsh session log 落合法 dsh SessionEvent（$DSH_HOME/sessions/…/session.v4.jsonl）
```

## 布局

| 路径 | 内容 |
| --- | --- |
| `vendor/zcode/` | ZCode 引擎快照（S01 vendored，inspect-only 于 S04） |
| `src/` | dsh 插件：`index.ts`（ZcodeLoop 工厂）+ `agent.ts`/`inbox.ts` + `bridges/`（model / event-store / tool / system-prompt 四座桥） |
| `cordis.patch.yml` | S03 的 profile patch 样例：disable stock `agent-loop` row + insert `zcode-loop` row（**必须先 disable 再 insert**，`agents.setFactory` 互斥） |
| `scripts/smoke.mjs` | S04 端到端冒烟（真实 dsh 进程 + headless 一次任务 + fake 模型 + log 断言） |
| `scripts/assert-facade-isolation.mjs`, `scripts/cold-start.ts` | S01 检查 |
| `scripts/s02-integration.ts`, `scripts/s03-integration.ts` | S02/S03 桥件集成自证 |
| `reference/` | 上游快照（只读） |

## 环境与运行

前置：Node ≥ 24（本机 26 验证通过）、pnpm 12。

```bash
pnpm install          # 拉取 @deepseek-ai/dsh 等（独立 npm 版 dsh）
pnpm build            # 构建 vendored workspace + 插件 dist/
pnpm verify           # 门面隔离 grep + S01 冷启动四事件
pnpm verify:s02       # S02 桥件集成自证
pnpm verify:s03       # S03 插件外壳集成自证
pnpm verify:s04       # S04 真实 dsh 端到端冒烟（集成验收）
```

## S04 冒烟在做什么

`node scripts/smoke.mjs`（= `pnpm verify:s04`）：

1. **隔离环境**：`DSH_HOME=.agent-work/tmp/smoke/home`（临时物，每次全新），
   `DSH_PERMISSION_MODE=danger-full-access`、`DSH_TELEMETRY_DISABLED=1`。
2. **打包**：esbuild 把 `dist/src`（S03 插件）与内置驱动源码各打成单文件 bundle
   （`@deepseek-ai/*` 保持 external —— 运行时由 dsh 的 runtime resolution 统一供给
   宿主单例），物化为 `<profile>/node_modules/dsh-plugin-zcode-loop/`。
3. **profile**：shipped `headless` template（dsh-base + dsh-headless bundle），
   patch 层 = S03 的 `cordis.patch.yml`（disable `agent-loop` + insert
   `zcode-loop`）+ 生成的 smoke overlay：
   - `agent-default-model` → provider/model = `mock/mock`（fake adapter）；
   - `session-title-llm` disabled（首 prompt 会偷跑 LLM）；
   - `system-prompt` personaPrefix 换回静态空段（headless 模板引用 `{{model}}`
     变量，而 zcode-loop 按已知缺口在 agent 发布前全局装配一次 prompt）；
   - `session-persistence-jsonl` 用 `compression: none`（落明文 jsonl，肉眼可查）；
   - insert `dsh-plugin-zcode-loop/smoke-driver` 行（fake 模型 + `echo_smoke_tool`
     驱动，跑在真实 dsh 进程里）。
4. **驱动**：`dsh --profile headless --patch … --patch … "<task>"` —— 脚本注入
   prompt，headless runner 等 turn 结束后把终答打到 stdout 并退出。
5. **断言（AC1）**：dsh 0 退出；终答正确；fake adapter 恰好 2 次调用；
   `echo_smoke_tool` 恰好执行 1 次且参数正确；`tools/pre-execute` ≥1（走 dsh
   管线非旁路）；首个模型请求携带全部经桥同步的 dsh 工具（本机 26 个，含 dsh
   自带 bash/fs/web/… 全表面，零 ZCode 内建泄漏）；`$DSH_HOME/sessions/…jsonl`
   存在且含 `turn/start…turn/end`、`tool/call`+`tool/result` 全序列。
6. **断言（AC2）**：独立重放子进程用 npm `@deepseek-ai/dsh-session-persistence-jsonl`
   后端把该 log 读回（v4 关系校验通过），喂给 npm `@deepseek-ai/dsh-session`
   重放：`deriveMessages()` 重建 `system → user → assistant → tool → assistant`
   骨干，终答与 dsh 渲染的工具结果（`output.render` 投影，管线证据）逐字匹配。

产物保留在 `.agent-work/tmp/smoke/`（session log、dsh stdout/stderr、driver
trace、bundle），可直接肉眼检查。

## 可选附加冒烟

- **真实模型**：`DEEPSEEK_API_KEY=… node scripts/smoke.mjs --real-model` ——
  provider/model 换 `deepseek-official/deepseek-flash`、不插 fake 行；不阻塞验收。
- **AC3（手动，肉眼）**：`DSH_HOME=.agent-work/tmp/smoke/home node
  node_modules/@deepseek-ai/dsh/lib/bin.js web` 起 web 进程，开一个会话确认
  回合推进。注意 web 走 `web` profile（默认 stock agent-loop），要看 zcode-loop
  需按 `cordis.patch.yml` 头部注释挂 patch：`dsh --profile web --patch
  <repo>/cordis.patch.yml`。

## 已知边界（原型范围）

- resume/fork 不支持（`agents.resume` 抛 `PROTOTYPE_UNSUPPORTED`）；steering
  v0 一律 next-turn；subagent 桥、compaction 桥接、spill 不做。
- system prompt 每 agent 装配一次（构造期），非每 turn 重装配；headless persona
  的 `{{model}}` 变量因此需要静态化（见 overlay）。
- createAgent 错误路径若在 tool/call 未解析时结束 turn，durable log 会被严格
  读取端拒绝（stock 用 TOOL_NOT_STARTED repair 事件处理；原型接受，happy path
  已验证）。
- `dsh web` 完整投影喂饱、升级 drill、golden round-trip 快照：PLAN 排除项。
- 模型能力元数据：contextWindow / 输入模态(text) / 推理档位 / maxOutputTokens 已从
  dsh `resolveModelInfo` 真实来源取值（取值链与断言见 `scripts/s02-integration.ts`
  AC5）；**video / audio / pdf 输入不支持**，image 输入因数据通路未落地被门控关闭，
  toolUpdate 机制未启用——原因与补齐路径详见 [docs/GAPS.md](docs/GAPS.md)。
