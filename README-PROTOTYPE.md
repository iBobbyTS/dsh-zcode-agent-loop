# zcode-loop-prototype — 把 ZCode AgentRuntime 嵌进真实 dsh 的原型

当前目标、两边能力的责任划分、完整接入任务及升级维护方案见 [完整接入计划](docs/INTEGRATION-PLAN.md)。清单与任务由 Codex 维护；本文后面的历史“原型排除项”保留现状信息，不再决定计划范围。计划中的功能尚未因文档落地而完成。

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
| `vendor/zcode/` | ZCode 引擎快照（vendored，inspect-only） |
| `src/` | dsh 插件：`index.ts`（ZcodeLoop 工厂）+ `agent.ts`/`inbox.ts` + `bridges/`（model / event-store / tool / system-prompt 四座桥） |
| `cordis.patch.yml` | profile patch 样例：disable stock `agent-loop` row + insert `zcode-loop` row（**必须先 disable 再 insert**，`agents.setFactory` 互斥） |
| `scripts/smoke.mjs` | 端到端冒烟（真实 dsh 进程 + headless 一次任务 + fake 模型 + log 断言） |
| `scripts/assert-facade-isolation.mjs`, `scripts/cold-start.ts` | 门面隔离检查 + 引擎冷启动自证 |
| `scripts/projection-integration.ts`, `scripts/pipeline-integration.ts`, `scripts/source-fidelity-integration.ts`, `scripts/goal-chain-integration.ts` | 桥件集成自证：事件投影/会话重建、dsh 管线装配、user/message source 保真、goal 工具链 |
| `reference/` | 上游快照（只读） |

## 环境与运行

前置：Node ≥ 24（本机 26 验证通过）、pnpm 12。

```bash
pnpm install          # 拉取 @deepseek-ai/dsh 等（独立 npm 版 dsh）
pnpm build            # 构建 vendored workspace + 插件 dist/
pnpm verify              # 门面隔离 grep + 冷启动四事件
pnpm verify:projection   # 事件投影与会话重建自证
pnpm verify:pipeline     # dsh 管线/插件外壳装配自证
pnpm verify:smoke        # 真实 dsh 端到端冒烟（集成验收）
pnpm verify:source-fidelity # user/message source 保真 + 压缩门单元（阶段 8a）
pnpm verify:goal-chain   # goal 工具链端到端（阶段 8b，真 goal 族插件 + mock LLM）
```

## 端到端冒烟在做什么

`node scripts/smoke.mjs`（= `pnpm verify:smoke`）：

1. **隔离环境**：`DSH_HOME=.agent-work/tmp/smoke/home`（临时物，每次全新），
   `DSH_PERMISSION_MODE=danger-full-access`、`DSH_TELEMETRY_DISABLED=1`。
2. **打包**：esbuild 把 `dist/src`（插件产物）与内置驱动源码各打成单文件 bundle
   （`@deepseek-ai/*` 保持 external —— 运行时由 dsh 的 runtime resolution 统一供给
   宿主单例），物化为 `<profile>/node_modules/dsh-plugin-zcode-loop/`。
3. **profile**：shipped `headless` template（dsh-base + dsh-headless bundle），
   patch 层 = 仓库根的 `cordis.patch.yml`（disable `agent-loop` + insert
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

- subagent 桥、spill 不做。
- **dsh goal 工具链已实测可用**（阶段 8，容器 probe：真插件 + mock LLM）：
  create/update_goal + goal-round-driver 自动续轮 + todo_write 全链走通——
  依赖三件桥接：user/message producer source 保真、turnBoundary 投影重挂、
  drain 的 initiator 边界（详见 CAPABILITIES.md §2 goal 族行）。已知边界：
  本插件已在每个模型步骤执行 `agent/pre-step`，接入 request/request-error，遵守拒绝、消息变换和 series 标记；请求与恢复使用有效 dsh surface，压缩归 dsh；一个 turn claim 多条消息时 surface 逐条落、引擎拿
  join 后单条文本（stock surface 一致，resume 水合为多条连续 user 消息）。
- **steering 真语义已支持**（阶段 6）：turn 进行中发送经 `agent.steer` 内联当前轮
  （引擎 `steerTurn` guide），空闲时安全降级排队；inbox live 事件全词表已发。
- **resume / fork 已支持**（2026-10-17 桥接批次）：冷重启后旧会话可续聊（最小
  `resumeFromStore`：dsh 事件逆向 + 哑 sessionStore）；fork（「在新对话中分支」）
  的 seeded create 复用同一水合，fork 后模型可见前缀上下文。实现与验收见
  `.agent-work/plans/` 归档与 [docs/CAPABILITIES.md](docs/CAPABILITIES.md) §2/§8。
  同批次接入：逐字流式（live `agent/assistant-stream`）、logger（stderr 双投递 +
  dropStats 打点）、会话内换模型/换档（`model/selection` 监听）、压缩可观测 +
  sidecar 隔离门。
- system prompt 每模型步骤按 agent scope 装配，prepared route 决定更新、清空与
  runtime-context 注入；引擎 CLI prefix 不再进入生产 provider 请求。
- 错误／取消路径已补工具结果恢复、可见文本保留和单调 dsh turn 身份；
  步骤、部分流、flush 失败及真实进程崩溃恢复均有严格 v4 读回验证。
- `dsh web` 完整投影喂饱、升级 drill、golden round-trip 快照：PLAN 排除项。
- 模型能力元数据：contextWindow / 输入模态(text) / 推理档位 / maxOutputTokens 已从
  dsh `resolveModelInfo` 真实来源取值（取值链与断言见 `scripts/projection-integration.ts`
  AC5）；**video / audio / pdf 输入不支持**，image 输入因数据通路未落地被门控关闭，
  toolUpdate 机制未启用——原因与补齐路径详见 [docs/GAPS.md](docs/GAPS.md)。
- 引擎能力层的完整桥接盘点（按模块、含量化口径与建议接入顺序）见
  [docs/CAPABILITIES.md](docs/CAPABILITIES.md)；事件投影层（84 种引擎事件的
  翻译/丢弃明细）见 [docs/PROJECTION.md](docs/PROJECTION.md)。

### 可重跑的 stock 宿主契约验证

`pnpm verify:matrix` 用已安装 `@deepseek-ai/dsh@0.2.1-alpha.5` 的 stock loop 与 ZCode loop 实际双跑 basic-text、todo-tool、goal-round/source/authority 场景。默认报告写入 `.agent-work/tmp/contract-verification/report.json`，可用 `--out DIR` 指定目录；`--strict-coverage` 对缺口增加门禁。运行后可用 `pnpm verify:contracts:selftest` 验证负向变异与重复运行确定性。

执行 PASS 要求双方场景有效且没有未允许差异；当前初始差分会如实报告 FAIL（包括注册集和事件结构差异），不能把场景断言通过等同于契约一致。完整 shipped base/web profile 家族与最小 mock fixture 分开统计；compact、side 和其他未运行家族显式无场景。此验证不证明 rewind、文件回滚或记忆能力。命令、退出码、归一化/允许项精度、扩展和升级流程见 [CONTRACT-DIFFS.md](docs/CONTRACT-DIFFS.md)，覆盖边界见 [CONTRACT-MATRIX.md](docs/CONTRACT-MATRIX.md)。

当前可操作统计：`pnpm verify:contracts` 同时生成三组场景差分和源码能力入口清单，报告在 `.agent-work/tmp/contract-classification/report/index.html`。**总状态为 INCOMPLETE**；场景 `bridge-gap: 0` 不代表全部能力已接通。入口按已桥接、引擎默认、dsh 已有替代、未接入、当前宿主无法直接桥接、待评估分别列出；新增声明/签名或生产接缝漂移会失败。默认退出0允许已明确列出的未接入项；`--strict-integration` 对这些项退出2，`--strict-coverage` 对场景覆盖不足退出2。仅扫描能力可运行 `pnpm verify:capabilities`。详见 [能力入口统计](docs/ENGINE-ENTRYPOINTS.md)；七类原始场景缺口的修复证据仍见 [当前修复与历史证据](docs/CONTRACT-ROOT-CAUSES.md)。
