# ZCode 引擎能力盘点（zcode-loop 桥接现状）

本文档按模块罗列 vendored ZCode 引擎（`AgentRuntime`）的全部能力面，并记录每项在
dsh 插件（`src/`）中的桥接现状。覆盖**引擎能力层**；姊妹篇：模型元数据层见
[GAPS.md](GAPS.md)，事件投影层（84 种 SessionEvent 的翻译/丢弃明细）见
[PROJECTION.md](PROJECTION.md)，三文档互链不重复。

## 版本锚定

- ZCode 快照 **v3.15.1**（[README-PROTOTYPE.md](../README-PROTOTYPE.md) 口径；vendor 内
  各包 `package.json` 为 private、不自带版本号）。
- vendored 引入基准：commit `4a836e6`，`vendor/zcode/` 与 `reference/` 快照
  **逐字节一致**，不可修改。
- **vendor 快照升级时本文档需整体重新盘点**——所有行都钉死在这个版本上。

盘点日期：2026-10-16。

## 状态图例

| 状态 | 含义 |
|---|---|
| 已桥接·完整 | 已接入且语义对齐（有验收证据） |
| 已桥接·有偏差 | 已接入但语义有损，偏差见备注 |
| 部分桥接 | 接了一半：一侧在跑、另一侧（事件/投影/消费面）缺失 |
| 待桥接 | 引擎有、dsh 无等价物，未接 |
| 无法桥接 | 结构性不可接（dsh 无对应词表/通路），原因见备注 |
| 不需要·dsh 等价 | dsh 层已有等价物承担，架构上刻意不接 |
| 不需要·边缘 | 两边都不需要（宿主形态/依赖已禁用的子系统） |
| 引擎内部·默认生效 | 随核心回路默认运行，无需桥接（配置可调处已注明） |

## 盘点口径（量化基准）

| 引擎公开面 | 总量 | 插件实际使用 |
|---|---|---|
| 公开方法（`core/src/runtime/agent-runtime.ts` 接口） | 92 | 1（`executeTurn`）+ 构造 |
| `AgentRuntimeConfig` 配置字段（`core/src/runtime/types.ts`） | 50 | 6 |
| `AgentRuntimeDeps` 依赖端口 | 52 | 5 |
| `core/src/runtime/methods/` 方法文件（不含 test） | 104 | turn-loop 家族 + 事件落盘 |
| 引擎 `SessionEventType` 事件类型（contracts） | 84 | 事件桥翻译 9，丢弃 75 |
| 引擎内建工具（`core/src/tool/handlers/`，约 30 族 + 工作流族） | 全量 | 注册 0（`toolAllowlist: []`），dsh 工具 26 个经桥全量同步（冒烟口径） |

插件传入的 7 个 config 字段：`workingDirectory` / `modelSelection` / `systemPrompt` /
`toolAllowlist` / `dynamicWorkflowEnabled` / `dynamicWorkflowToolsOnDemand`（后两个为
显式关闭）/ `modelStreaming`（缺省 "on"）。传入的 6 个 deps 端口：`eventStore` /
`modelFactory` / `toolRegistry` / `permissionBroker`（直通 allow）/ `contextBuilder` /
`logger`（阶段 2 接通）；resume 路径另有 `sessionStore`（哑适配器，见 §8）。

**路径约定**：「引擎源码」相对 `vendor/zcode/apps/zcode-cli/`；「桥实现」相对仓库根。

---

## 1. turn 循环与模型通路

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| turn 主循环 | 多步模型↔工具循环、abort、maxTurns | `core/src/runtime/methods/turn-loop.ts`、`turn-model-step.ts` | `src/agent.ts`（drain → `executeTurn`） | 无（本插件即替代 stock loop） | 已桥接·完整 | 冒烟 AC1/AC2 + 浏览器验收（含真实模型）。错误路径 tool/call 未解析时 durable log 会被严格读取端拒绝（README 已知边界） |
| 逐字流式 | `modelStreaming:"on"` 时走 `streamText` 并发 delta 事件 | `core/src/runtime/methods/context.ts`（`shouldStreamModelText`）、`model.ts` | `src/bridges/model-bridge.ts`（`streamText`→`prepared.stream`）、`src/bridges/event-store-bridge.ts`（`accumulateStreaming` + live `agent/assistant-stream` frame：start/chunk/end，attemptId/revision 语义照抄 stock `AssistantStreamAttempt`）、`src/index.ts`（Config.streaming 缺省开） | stock 的 live 面（web UI 逐字渲染） | 已桥接·完整 | 阶段 1 实测：0.4s 采样 20+ 步连续渐增；落盘 `assistant/message` 带真实累积 `stream` |
| 流中工具执行 | 流式中提前调度已完整的 tool-call | `core/src/runtime/methods/streaming-tool-coordinator.ts` | —（引擎 turn 流程内部行为） | 无 | 引擎内部·默认生效 | 阶段 1 流式开启后自动活跃，无需桥接 |
| 输出 token 续写 | `finishReason=length` 时自动续写（≤3 次），与压缩协同 | `core/src/runtime/methods/turn-output-token-continuation.ts` | — | 无 | 引擎内部·默认生效 | 无条件生效，无需桥接 |
| 流恢复 | 断流锚点/重试/尾部丢弃 | `core/src/runtime/methods/streaming-recovery.ts` | — | 无 | 引擎内部·默认生效 | 非流式下少触发 |
| 模型异常防护 | 异常流检测与 `ModelAnomalyWarning` | `core/src/runtime/methods/turn-loop-state.ts`、`helpers/model-errors.ts`（config `modelAnomalyGuard` 可调） | — | 无 | 引擎内部·默认生效 | 配置未传，按默认策略 |
| 请求 token 预算 | 上下文窗口/最大输出预算计算 | `core/src/runtime/methods/model-token-limits.ts` | 声明来源经 `src/bridges/model-bridge.ts`（dsh `resolveModelInfo`） | 无 | 已桥接·完整 | 取值链见 GAPS.md |
| mid-conversation system | 对话中 system 消息注入策略 | `core/src/runtime/types.ts`（`midConversationSystem`） | 模型声明（`supportsMidConversationSystem`）经 model-bridge | 无 | 已桥接·有偏差 | 按 dsh `systemPromptUpdate === 'in-history'` 声明，其余 false（GAPS.md） |
| 运行期换模型/换档 | `setSessionModelSelection` / `recordPendingModelChange` / 执行档选择回退 | `core/src/runtime/methods/model-selection.ts`、`turn-execution-fallback.ts` | `src/index.ts`（宿主 ctx 监听 `model/selection` → `applyModelSelection`：resolveModelInfo → factory.refresh → setSessionModelSelection）、`src/bridges/model-bridge.ts`（factory 按 `input.selection` 取路由 + `refresh({resolved})` 热更新声明）；resume 初始 selection 用 `foldRequestHeader` 从 seed 恢复 | dsh UI 模型选择器 | 已桥接·完整 | 阶段 4 实测：换档 High→Low 下一 turn 生效（请求带 reasoning 流）。监听必须挂宿主 ctx（agent scoped ctx 收不到 `session/event`，probe 证据在 `.agent-work/tmp/stage4-model-selection/`）；档位跨 resume 保留（dsh 侧状态），插件 resume 不恢复档位（归 controller） |
| provider 请求头刷新 | 请求前账户/鉴权刷新端口 | `core/src/runtime/methods/model-runtime-headers.ts` | 未接 | dsh adapter 自管鉴权（apiKeyEnv） | 不需要·dsh 等价 | |
| 前台执行租约 / residency | 桌面宿主的前台提升与驻留追踪 | `core/src/runtime/methods/residency.ts` | 未接 | 无 | 不需要·边缘 | 桌面宿主形态字段 |

## 2. 输入与队列

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 中途转向（steer） | turn 进行中注入转向输入（next-step/next-turn 语义） | `core/src/runtime/methods/steering.ts`、`turn.ts` | `src/agent.ts`（阶段 6 真语义：busy 时 `steerActive` → 留痕 + surface user/message + `runtime.steerTurn({delivery:"guide"})` 内联当前轮；idle 降级 next-turn；inject 修正为 next-step 不唤醒） | stock 的 next-step 语义 | 已桥接·完整 | 程序化验收（steer-probe）：同 turn 第二个请求携带转向文本、turn 计数不变、splices 双留痕、live inbox 事件可见；空闲时 steerTurn rejected（no_active_turn）安全降级排队 |
| 待发队列（编辑/重排/删除） | 引擎 pending-input 队列全套 API | `core/src/runtime/command-queue.ts` + pendingInput 系列方法 | 插件 `src/inbox.ts`（`ZcodeLoopInbox` 自实现 append/prepend/replace/remove/splice，落 `agent/inbox/spliced`） | 插件 inbox 即 dsh `Inbox` 接口实现；标准 `inbox` state/wire 投影 | 不需要·dsh 等价 | `verify:inbox-projection`：双队列命令、stock 公共读面对照、seed/resume pending 实际消费、卸载与无服务回退；live 事件与 steer/inject 保留 |
| followup 模式（queue/guide）/ 自动排水 | `setFollowupMode` / `setQueueAutoDrain` | `core/src/runtime/methods/runtime-command-*.ts` | 未接 | 无 | 不需要·边缘 | 插件自管 drain 循环 |
| 输入准入 | `admitPrompt` 交互准入票据 | `core/src/runtime/methods/prompt-admission.ts` | 未接 | 无 | 不需要·边缘 | 宿主交互形态；插件 inbox 承担输入面 |
| user/message source 保真 | producer source（user/goal/scheduler…）随消息落 surface | —（stock loop 逐条 append 原消息对象） | 阶段 8a：claim 批原消息经 `setPendingUserMessages` 透传，`model_request` 逐条落盘（steering 路径同款直接 append 原消息）；无批回退引擎 text 重建 `{kind:"user"}` | — | 已桥接·完整 | goal 续轮（round driver 预约校验按 source/goalId/round 匹配）依赖此保真；source-fidelity 脚本 AC1/AC2/AC4 回归 |
| turnBoundary 投影 | goal 工具开轮边界 authority（`stateOf(session,"turnBoundary")`） | —（stock 由 agent-loop 注册 `turnBoundaryProjectionDefinition`） | 阶段 8b：`src/index.ts` 重挂同语义投影（纯 turn/step 事件解释，运行时 `ctx.inject` 可选注册——host 回归面无 sessionProjections 服务时跳过） | dsh-session-projection | 已桥接·完整 | 容器 probe 实测：缺它 create_goal 拒绝 "goal tools require an open model turn" |
| initiator 边界 | `ctx.agents.currentInitiator()`（AsyncLocalStorage） | —（stock `withInitiator(this, kick)`） | 阶段 8b：drain 包 `runWithInitiator`（`withInitiator(agent, drain)`） | dsh-agent | 已桥接·完整 | goal 工具 authority 的第三要素；probe 实测无 GOAL_TOOL_* 拒绝 |
| dsh goal 工具链 | create/get/update_goal + goal-round-driver 自动续轮 + todo_write | —（全在 dsh 层） | 工具经桥同步（todo_write/get_goal/create_goal/update_goal）；续轮 = followup(goal-source 消息) 走 inbox→drain 正常通路 | dsh-goal / dsh-goal-round-driver / dsh-tool-goal / dsh-tool-todo | 已桥接·完整（阶段 8 实测） | 双层验收：host 回归 `pnpm verify:goal-chain`（tsx 直跑 src；goal 族钉 0.2.1-alpha.5 已进 devDependencies——npm dist-tag latest 钉在坏代际 0.0.1-rc.1，装必须带版本号）+ 容器 probe（真插件 + mock adapter，验部署同字节 bundle）：续轮真实发生（4 请求恰量）、goal-source user/message 落盘、goal 达 complete、todo/write 落盘、turn ×2；已知边界：本插件不发 `agent/pre-step`，goal 驱动器对无效轮的 fail-closed 拦截不生效（happy path 不受影响）；装配 dsh-tool-* 需先有 sessionProjections 服务，否则插件 inject 挂起不注册工具 |

## 3. 工具系统

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 内建工具面（全禁） | bash/read/edit/write/glob/grep/webfetch/websearch/todo/skill/cron/off-peak/ask-user-question/plan-mode/target/node-repl/agent/媒体读取（image/pdf/video/session-context）/消息族/工作流族 等 | `core/src/tool/handlers/` | `config.toolAllowlist: []` 全禁；`src/bridges/tool-bridge.ts` 只同步 dsh 工具 | dsh-tool-bash / fs / fs-search / str-replace-editor / web / todo / skill / schedule / jobs / ask-user / goal / subagent / workflow / terminal … | 不需要·dsh 等价 | 冒烟断言「零 ZCode 内建泄漏」；dsh 26 工具经桥全量进引擎 |
| 工具注册表与每 turn 同步 | 增量 upsert + 撤销消失项 | `core/src/tool/registry.ts` | `src/bridges/tool-bridge.ts` `syncTools()` | — | 已桥接·完整 | 每 turn 前同步（任务合同） |
| 工具执行/调度 | 并发分类、批跑、取消、超时 | `core/src/tool/scheduler.ts`、`tool/executor/` | 桥 handler → `ctx.tools.execute`（dsh 管线） | dsh ToolRuntime（pre-execute waterfall） | 已桥接·有偏差 | 并发分类 fail-closed（`isConcurrencySafe` 缺席/异常按独占）；桥 120s 超时 / 256KB 截断为常量，dsh 的 timeout-policy 插件不被感知 |
| 工具元数据映射 | `ToolEntry` 元数据（readOnly/destructive/concurrentSafe/needsApproval/riskLevel/sideEffectScope） | `core/src/tool/types.ts` | `src/bridges/tool-bridge.ts`（注册期映射） | dsh `ToolDefinition` | 已桥接·有偏差 | 仅 `concurrentSafe` 有真实来源；其余硬编码——`needsApproval:false` 使引擎永不发起权限交互（有意，交给 dsh） |
| toolUpdate（工具集变更随历史） | `tool-addition`/`tool-removal` 块 + `toolHistory` 投影 | dsh llm 侧机制 | 未启用 | — | 无法桥接（短期） | 每请求发完整 tools，中途装/卸插件会打断 provider 前缀缓存；详见 GAPS.md「未启用：toolUpdate」 |

## 4. 权限

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 权限服务/规则匹配 | 引擎侧权限规则与审批流 | `core/src/permission/`（service、rule-matching、broker） | `src/engine-facade.ts` `createAllowThroughPermissionBroker`（直通 allow） | dsh pre-execute waterfall + `DSH_PERMISSION_MODE` | 不需要·dsh 等价 | 把关责任整体交 dsh 管线（模块头声明） |
| plan mode | `planEnabled` + plan-mode 工具 + 只读 turn | `core/src/permission/plan-mode-policy.ts`、`methods/control-only-turn.ts` | 未接 | dsh 权限模式（含 plan） | 不需要·dsh 等价 | |
| full-access 授权/恢复 | `grantPermissionFullAccess` 及崩溃恢复 | `core/src/runtime/permission-full-access.ts`、`permission-grant-recovery.ts` | 未接 | 无 | 不需要·边缘 | 依赖引擎权限交互面（已直通） |

## 5. 上下文与压缩

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 上下文装配 | system prompt 注入、env/日期/提醒、引擎默认 builder | `core/src/context/`、`methods/context.ts` | `src/bridges/system-prompt-bridge.ts`（构造期装配一次 → `config.systemPrompt`；首轮后引擎 rebuild 沿用） | dsh system-prompt 插件族（persona/段/变量） | 已桥接·有偏差 | **每 agent 装配一次**，dsh prompt 插件运行期改段不热更（README 已知边界）；`{{provider}}`/`{{model}}` 变量已注册 |
| 自动压缩（auto-compact） | 超阈自动摘要压缩，**缺省开启**（仅显式 `enabled:false` 关闭） | `core/src/compact/policy.ts`、`methods/compact.ts` | 摘要请求经 model-bridge 走 dsh 路由；事件桥 compact 门（sidecar `model_*` 不翻译）+ logger 镜像 | dsh-compaction-*（surface 修剪事务族，dsh 等价物） | 已桥接·有偏差 | 阶段 5 实测全链路（小 contextWindow 触发）：摘要真实走 LLM、压缩完成、落盘无污染。**Compact 5 类事件不落盘**（dsh compaction/* 是事务族，手工构造有损坏 session log 风险，见 PROJECTION.md）；日志镜像 + dropStats 可见 |
| microcompact | 工具结果级微压缩 | `core/src/compact/microcompact.ts` | 同上 | 同上 | 已桥接·有偏差 | 同 auto-compact（microcompact_boundary 不落盘不镜像，drop 计数） |
| 手动 /compact 命令 | 命令面触发压缩 | `ExecuteTurnOptions.commandKind: "compact"` | 未接 | 无 | 不需要·边缘 | 无命令面宿主 |
| system reminders | todo 提醒等合成注入 | `core/src/system-reminder/`、`helpers/runtime-reminders.ts` | 随内建 todo 禁用而关闭（`src/index.ts` 注释明示） | 无 | 不需要·边缘 | 依赖引擎内建 todo 工具 |
| 上下文用量观测 | 用量快照/明细日志 | `core/src/runtime/methods/context-usage*.ts` | `deps.logger` 已接（阶段 2）→ `context.built`/`compact.auto.*` 日志可见 | 无 | 已桥接·完整 | 阶段 5 实测：每次请求的 token 明细与压缩决策都在容器日志 |

## 6. 子代理

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 引擎子代理子系统 | child runtime 编排：Explore/general-purpose profile、持久记忆、coordinator 响应、消息转向、事件镜像 | `core/src/subagent/`（runner/profile/persistent-memory/coordinator-response/tool-event-mirror…） | 未接（`deps.subagentPort` / `config.subagents` 缺席） | dsh-tool-subagent + dsh-tool-subagent-control（dsh 工具形态，经桥即可用） | 不需要·dsh 等价 | 语义不同构（引擎 child runtime vs dsh 工具自治）；若要引擎版需节级工作（含 Subagent* 3 类事件投影） |

## 7. 动态工作流

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 动态工作流 | ~10 个工作流工具 + amend/fill-hole/save/eval/resume + run/snippet/modelCatalog 端口 | `core/src/workflow/`、`packages/dynamic-workflow/` | 显式关闭（`dynamicWorkflowEnabled:false` + onDemand:false） | dsh-tool-workflow | 不需要·dsh 等价 | README PLAN 排除项；`DynamicWorkflowRunProgress` 等事件随之不产生 |

## 8. 会话持久化·恢复·回溯

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 事件→dsh v4 投影 | 引擎 SessionEvent 翻译为合法 dsh SessionEvent 落 jsonl | contracts `SessionEventType`（84 类型） | `src/bridges/event-store-bridge.ts` | dsh session-persistence-jsonl | 已桥接·完整 | 翻译 9 类型；其余 75 类型的逐类明细（会发出被丢 / 门控不产生 / 无发射点）见 [PROJECTION.md](PROJECTION.md)；阶段 5 起压缩 sidecar 的 `model_*` 也不翻译（压缩门）；冒烟 AC2 独立重放逐字匹配 |
| resume / 冷恢复 | `resumeFromStore` + 会话水合 | `core/src/runtime/methods/resume.ts`、`agent/session-history-hydrator.ts` | `src/bridges/resume-adapter.ts`（dsh 事件→引擎 `MessageWithParts` 逆向 + 哑 `SessionStorePort`：读空写吞）+ `src/index.ts`（stock resumeWith 形状：persistence.open→read→interruptedTurnClosers→prepare(seed)→装配→`resumeFromStore({persistedMessages})`）+ 事件桥 turn 号偏移（setTurnBase） | dsh session jsonl | 已桥接·完整 | 阶段 3 实测：容器冷重启后旧会话续聊、模型答出重启前数字、jsonl turn 连续；blank 会话（UI 固定 id）经 resume 复活。哑 store 必须吞 `saveMessage/savePart`（sessionPersisted=true 后 turn 循环每消息都调）；turn 偏移防重复 turn 号（v4 会拒绝，实测样本在 `.agent-work/tmp/dsh-home-config-backup/sessions-corrupt-pre-turnfix/`） |
| rewind | 对话回退到某消息重跑 | `core/src/runtime/methods/rewind.ts`、`rewind-message.ts` | 未接 | 无 | 待评估（低优先） | |
| checkpoints / 文件回滚 | 工作区检查点、文件级回滚预览/应用 | `core/src/runtime/methods/workspace-checkpoints.ts`、`file-rewind.ts` | 未接 | 无 | 待评估（低优先） | |
| fork | 会话/工作区 fork、稳定 fork 边界、选区旁路会话 | `core/src/runtime/methods/session-fork.ts`、`workspace-fork.ts`、`stable-fork-boundary.ts` | `src/index.ts`（阶段 7：seeded createAgent（controller fork 路径）在 seed 含历史时复用 resume 水合——`resumeFromStore` + turnBase 对齐） | dsh controller `fork()` + `buildForkSeed` | 已桥接·完整 | 程序化验收（fork-probe）：fork 首请求携带源会话上下文、turn 号 [seeded,新] 连续。引擎自带的 workspace/stable-boundary fork API 未用（dsh 层承担派生语义） |
| 投影 API | `getProjection` / `subscribeEvents` | `core/src/runtime/methods/` | 未用（桥自行翻译） | — | 不需要·dsh 等价 | 事件桥即投影承担者 |

## 9. 后台任务

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 引擎后台任务 | 后台 bash 生命周期/输出读取/通知/取消、runtimeTaskRegistry | `core/src/runtime-task/`、`methods/background*.ts` | 未接（`runtimeTaskRegistry` 缺席） | dsh-tool-jobs / schedule / terminal（工具自管后台） | 不需要·dsh 等价 | turn 内取消走 abort 信号即可 |

## 10. 记忆

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 项目记忆 | 会话后自动 Extraction、召回注入、持久记忆 | `core/src/memory/`（含 recall）、`config.memory` | 未配置 | 无 | 待评估 | dsh 无等价；是否引入属产品决策（需存储根与事件投影） |

## 11. 技能·MCP·hooks

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 引擎技能面 | `skillPort` / `getSkillCatalog` / `skillMetadataBudget` | contracts SkillPort、`core/src/` skills 面 | 未接 | dsh-tool-skill | 不需要·dsh 等价 | |
| 引擎 MCP | `mcpPort` / `config.mcp.servers` / trusted CUA server | `core/src/mcp/` | 未接 | dsh MCP 工具注入（工具形态进 `ctx.tools`） | 不需要·dsh 等价 | |
| workspace hooks | hookRunner/admission/snapshot + HookRun 事件族 | `core/src/hooks/` | 未接 | dsh 工具管线 pre/post-execute（不同层） | 不需要·边缘 | |

## 12. 遥测与可观测

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| agent/步骤遥测 | `deps.agentTelemetry` 端口族 | `core/src/telemetry/`、`methods/usage-observability.ts` | 未接 | 无 | 无法桥接（2026-10-17 改判） | agentTelemetry 是 ZCode 宿主自家的 collector 体系，dsh 无对应消费者；用量观测已由 session 事件 usage 字段（UI 的 tok/统计）+ 阶段 2 logger 覆盖 |
| tracing | TraceContext / root trace 贯穿 | `core/src/` tracing 面 | 未接（事件 traceId 不投影；引擎日志里的 traceId/spanId 经 logger 可见） | 无 | 无法桥接（2026-10-17 改判） | dsh SessionEvent 词表无 trace 概念，无落点；引擎日志侧 traceId 已随阶段 2 logger 可 grep |
| logger | `deps.logger` | 各模块 `this.logger?.debug` | `src/bridges/logger-adapter.ts`（cordis buffer + **stderr 直写双投递**：cordis web 模式 LoggerService 只注册内存 buffer exporter，docker logs 需 stderr；headless stdout 纯净断言靠 stderr 分流）+ 事件桥 dropStats 随每 turn 打点 | dsh 日志面 / docker logs | 已桥接·完整 | 阶段 2 实测：引擎全量日志（context.built/session.resumed/turn.phase.*/compact.*）与 dropStats 行容器可见 |

## 13. 浏览器·CUA·node_repl

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 浏览器控制 | browserControlPort、browser-client、截图回合、ambient context | `core/src/browser-client/`、`methods/browser-turn-screenshot.ts` | 未接 | dsh 侧 MCP 浏览器工具（chrome-devtools 等） | 不需要·边缘 | |
| CUA | zcode-cua 包、computer-use 凭据注入 | `packages/zcode-cua/` | 未接 | 无 | 不需要·边缘 | |
| node_repl | `runtimeFeatures.nodeRepl` js 工具 | `core/src/tool/handlers/node-repl.ts` | 未接 | 无 | 不需要·边缘 | |

## 14. 宿主与杂项

| 功能 | 描述 | 引擎源码 | 桥实现 | dsh 等价物 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 会话标题生成 | titleGeneration 配置、sidecar、目标摘要标题 | `core/src/runtime/methods/session-title.ts`、`title-generation-sidecar.ts`、`goal-summary-title.ts` | 未接 | dsh session-title-llm | 不需要·dsh 等价 | smoke 中显式 disable 以防首 prompt 偷跑 LLM |
| shell 环境 | 会话 shell 初始化/快照/选择 | `methods/session-shell-environment.ts`、`bash-shell-snapshot.ts` | 未接 | 无 | 不需要·边缘 | 依赖内建 bash（已禁） |
| embedded search | 搜索后端选择、bfs/ugrep prelude | `core/src/embedded-search/` | 未接 | dsh-tool-fs-search | 不需要·边缘 | |
| prompt 微调 | `language` / `outputStyle` / `agentName` / `workflowActor` / `subagentContext` | `core/src/runtime/types.ts` | 未传 | dsh system-prompt 装配已承担 | 不需要·边缘 | |
| 指令/项目上下文 | `userInstructions`（AGENTS.md）/ `projectContext` / `envInfo` / `currentDate` | `core/src/runtime/types.ts` | 未传（dsh 装配的 systemPrompt 整段已含） | dsh system-prompt 插件族 | 不需要·dsh 等价 | |
| 桌面宿主形态 | `clientMode` / `deliveryKind` / `presentationSurface` / `genUiOutputRoot` / `taskType` / `parentSessionId` | `core/src/runtime/types.ts` | 未传 | 无 | 不需要·边缘 | ZCode 桌面/协议宿主字段 |
| 宿主侧模型工具 | `generateWorkspaceText` / `sampleModel` / `testModelConnectivity` | `core/src/runtime/methods/workspace-generate-text.ts`、`sample-model.ts` | 未接 | 无 | 不需要·边缘 | 宿主自用工具面 |
| plugin-reference / PluginUi | `plugin://` 引用目录 + PluginUi 事件族 | `core/src/plugin-reference/` | 未接 | 无 | 不需要·边缘 | |

---

## 建议接入顺序（2026-10-17 已全部完成）

1. ~~**逐字流式**~~（阶段 1，已完成）：live `agent/assistant-stream` frame + `modelStreaming:"on"`。
2. ~~**logger 接通**~~（阶段 2，已完成）：stderr 双投递 + dropStats 打点。
3. ~~**resume / 冷恢复**~~（阶段 3，提前实施——resume 缺失挡住 web 全部交互，已完成）：
   最小 `resumeFromStore`（哑 store + persistedMessages 逆向）。
4. ~~**会话内换模型/换档**~~（阶段 4，已完成）：`model/selection` 监听 + selection 优先 factory。
5. ~~**compaction 事件投影**~~（阶段 5，已完成·改范围）：不做落盘翻译（dsh compaction/*
   是 surface 修剪事务族，手工构造有损坏风险）；改为日志镜像 + 压缩门（sidecar `model_*`
   不翻译，防摘要污染 surface——实测发现的真 bug）。

6. ~~**steering 真语义**~~（阶段 6，已完成）：`steerTurn`（guide 内联当前轮）+
   inject 修正 + live inbox 事件 + steering 的 surface 投影。
7. ~~**fork**~~（阶段 7，已完成）：seeded createAgent（controller fork 路径）复用
   resume 水合——fork 后模型可见前缀上下文。

实施记录与验收证据见 `.agent-work/plans/2026101*-*`（仓库内不入库）。其余
（rewind/checkpoint/记忆/遥测）按产品需要评估。

---

## 附录 A：dsh Agent / Inbox 接口面

插件对 dsh `Agent` 接口（`@deepseek-ai/dsh-agent`）13 个成员**全部实现**
（`src/agent.ts`），语义偏差两处；`Inbox` 接口 10 个成员全部实现（`src/inbox.ts`）。

| 接口成员 | 语义 | 插件实现 | 状态 |
|---|---|---|---|
| `id` / `session` / `options` / `ctx` / `inbox` | 身份与上下文属性 | 全实现；`ctx` 为 per-agent scoped（preset 绑定修复，见 `src/agent.ts:50` 注释） | 已实现 |
| `status` | idle⇄running，经 `agentEvents` 发 `agent/status` | `setPhase` 派发 | 已实现 |
| `followup` | 入队 + 唤醒 | next-turn 入队 + `wake()` | 已实现 |
| `steer` | turn 进行中转向 | **真语义**（阶段 6：busy 时内联当前轮，见 §2） | 已实现（见 §2） |
| `inject` | 不唤醒注入 | next-turn 入队、不唤醒 | 已实现（v0 语义） |
| `send` | 定向投递 | `target` 忽略，仅按 `wakeup` | 已实现（target 不区分） |
| `cancel` | 取消当前活动 | abort 当前 turn + 清 inbox（`keepInbox` 可留） | 已实现 |
| `whenIdle` | 等待静止 | activity promise 链 | 已实现 |
| `runMaintenance` | idle 起跑非 turn 任务 | 同步抛错守卫 + 信号随 cancel | 已实现 |
| Inbox `append`/`prepend`/`replace`/`remove`/`splice`/`claim`/`clear` 等 10 成员 | 持久队列（`agent/inbox/spliced` 为唯一真相） | `ZcodeLoopInbox` 全实现 | 已实现 |
| live inbox 事件 | stock 运行期发 `agent/inbox/*` live 事件 | **已发**（阶段 6：inbox 的 emitLive 回调 → agent dispatch，inserted/claimed/discarded 全词表；落盘完整保留） | 已实现 |
| next-step 队列 | turn 结束前插队语义 | **有生产者**（阶段 6：steer/inject busy 时经 steerActive 消费进当前轮，idle inject 排队随 drain 拼接） | 已实现 |

## 附录 B：工具元数据层（dsh ToolDefinition → 引擎 ToolEntry）

`src/bridges/tool-bridge.ts` 注册期的字段级映射（工具面总量见 §3）：

| ToolEntry 字段 | dsh 来源 | 现状 |
|---|---|---|
| `capability` | 合成 `dsh.tool.${name}` | 命名等价 |
| `inputSchema` | `ctx.tools.schemas()` 的 `parameters`（归一化） | 直传 |
| `outputSchema` | — | `{}` 占位（本通路引擎不消费） |
| `permission` | 合成 `dsh.tool.${name}` | 合成 |
| `handler` | `ctx.tools.execute`（带 agent、abortSignal） | 真实通路 |
| `metadata.concurrentSafe` | dsh `isConcurrencySafe` 探测 | **真实来源**（缺席/异常按独占，fail-closed） |
| `metadata.readOnly` / `destructive` / `riskLevel` / `sideEffectScope` | — | 硬编码（false/false/"low"/"none"，无 dsh 来源） |
| `metadata.needsApproval` | — | 硬编码 `false`（有意：把关交 dsh 管线） |
| 执行面常量 | — | 超时 120s / 结果预算 256KB（`tool-bridge.ts` 顶部常量），与 dsh timeout-policy 插件互不感知 |

## 附录 C：插件配置暴露面

插件 `Config`（`src/index.ts`）现有 5 字段：`provider` / `model` /
`contextWindow?` / `maxOutputTokens?` / `streaming?`（缺省 true，阶段 1 加）。
引擎 50 个 config 字段中值得陆续暴露的子集（均未决，接一项加一行）：

| 建议暴露 | 引擎字段 | 理由 | 状态 |
|---|---|---|---|
| 流式开关 | `modelStreaming` | 阶段 1 的配套开关 | **已暴露（streaming）** |
| 循环上限 | `maxTurns` | 防失控 turn 的运维 knob | 未决 |
| 压缩策略 | `compact.enabled` / `thresholdPercentOverride` | auto-compact 缺省开启但不可配；阶段 5 实测用 `contextWindow` 小值触发（已可用） | 未决 |
| 语言 | `language` | 影响 dsh 装配外的引擎自带段落（当前未用） | 未决 |
| 工具并发 | `toolConcurrency.maxConcurrency` | 与 dsh 管线并发策略对齐时需要 | 未决 |

<!-- BEGIN host-contract-evidence-reference -->
宿主契约的可重跑证据与本页引擎能力盘点分别管理：见 [CONTRACT-MATRIX.md](CONTRACT-MATRIX.md) 和 [CONTRACT-DIFFS.md](CONTRACT-DIFFS.md)。`pnpm verify:matrix` 生成实际 npm stock/ZCode 双跑差分、源码义务及 shipped profile 家族矩阵；执行失败、允许差异与覆盖缺口单独呈现，不代表本页能力已全部桥接。
<!-- END host-contract-evidence-reference -->
