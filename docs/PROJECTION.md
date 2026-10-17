# 事件投影层：引擎 SessionEvent → dsh SessionEvent（zcode-loop 桥接现状）

本文档覆盖**事件投影层**：vendored ZCode 引擎的 `SessionEventType`（84 种）中，
哪些被 `src/bridges/event-store-bridge.ts` 翻译成合法 dsh SessionEvent 落进
`session.v4.jsonl`，哪些被丢弃、丢弃是否有损失。它是「**哪些引擎行为 dsh 日志与
UI 永远看不到**」的契约清单。

- 引擎能力层盘点见 [CAPABILITIES.md](CAPABILITIES.md)；模型元数据层见 [GAPS.md](GAPS.md)。
- 版本锚定与 [CAPABILITIES.md](CAPABILITIES.md#版本锚定) 相同：ZCode 快照 v3.15.1、
  vendored 基准 commit `4a836e6`、`vendor/zcode/` 与 `reference/` 逐字节一致；
  **vendor 升级时本文档需重盘**。盘点日期 2026-10-16。

## Durable inbox 会话投影（2026-10-17）

`src/inbox.ts` 提供与 stock 相同的 `inbox` 投影：`stateVersion: 1`，初值为
空 `next-turn` / `next-step`，仅折叠 `agent/inbox/spliced`。`sessionProjections`
在场时，loop 与 `turnBoundary` 一并注册它；`stateOf(session, "inbox")` 和
`snapshot(session).values.inbox` 返回有序完整消息，保留 id、content 与 source。
插件卸载自动移除注册；无投影服务的最小环境仍可使用 inbox 命令。

队列与公共投影共享严格 splice 折叠。队列首次读取重放 seed/resume 日志，后续
按 watermark 补读已提交事件，因此重建后 pending 不会消失，已消费输入也不会
重复出现。非法持久坐标或跨队列重复 id 抛出带 session seq 和 cause 的错误；
命令传入的坐标仍按 JavaScript splice 规则归一化，重复 id 在落盘前拒绝。

`pnpm verify:inbox-projection` 使用真实 session、registry、loop 插件及 mock adapter，
对照已安装 stock loop 的公共 state/wire 读面，覆盖双队列命令、claim/clear、
非法历史、seed 与 JSONL 冷恢复后实际消费、卸载和无服务回退。浏览器队列展示
依赖的 live inbox 事件仍由现有 agent dispatch 发出；该脚本不代替 UI 验收。

## 口径

| 分类 | 数量 | 含义 |
|---|---|---|
| 已翻译 | 9 | 事件桥有 case，落为合法 dsh 事件 |
| **会发出·被丢** | 8 | 当前引擎配置下**真实发出**、桥按未知类型丢弃——有感知损失的集合（2026-10-17 起 compact 3 类 + anomaly 为「日志镜像 + drop」，压缩 sidecar `model_*` 另有门控 drop，见第二节） |
| 门控·不产生 | 46 | 对应子系统/端口未启用，事件根本不会发出 |
| core 无发射点 | 21 | core 内无发射引用（宿主/协议层注入或遗留类型），本插件路径不可能出现 |
| 合计 | **84** | contracts `SessionEventType` 全集 |

分类方法：静态核查（发射点引用 + 子系统启用条件）；个别类型的动态行为以桥的
`dropStats()` 实测为准（该统计当前只在内存，见文末建议）。

## 一、已翻译的 9 种（引擎事件 → dsh 落盘事件）

| 引擎事件 | 桥的翻译 | dsh 落盘事件 |
|---|---|---|
| `turn_started` | 记 turn、user 文本暂存 | `turn/start` |
| `model_request` | 上一步缓冲落定 + 开新步；首个请求落 system（前导 system 拼接为一条）；user/message 落盘**优先用 claim 批原消息**（producer source 保真，阶段 8a），无批时回退引擎 text 重建 `{kind:"user"}` | `step/end`(若有) → `step/start` → `system/message`(仅首个) → `user/message` → `request/header` |
| `model_streaming` | 不直接落盘；累积为紧凑流 | （折进 `assistant/message` 的 `stream` 字段） |
| `model_complete` | 缓冲 assistant | （等工具调度或下一边界 flush 成 `assistant/message`） |
| `tool_call_scheduled` | 缓冲 assistant（含 tool-call 块）先落定 | `assistant/message` → `tool/call` |
| `tool_call_result` | 按 callId 序号回联 | `tool/result`（`isError` 按 `success`） |
| `tool_call_error` | 错误文案与元数据 | `tool/result`（`isError:true` + `error`） |
| `turn_complete` | 缓冲落定 + 收口 | `assistant/message`(若有) → `step/end`(若 open) → `turn/end`{completed} |
| `turn_error` | 同上错误路径 | → `turn/end`{error} |

缓冲不是丢失：是 v4 关系校验要求的翻译排序（assistant 必须先于其 tool 结果进入
surface）。`model_streaming` 阶段 1 起常态活跃（`modelStreaming:"on"`）：除折进
`assistant/message.stream` 外，有 publisher 时逐 chunk 发 live `agent/assistant-stream`
frame（start/chunk/end，attemptId/revision 语义照抄 stock `AssistantStreamAttempt`）。

## 二、会发出·被丢（现实缺口，8 种 + 压缩 sidecar）

> 2026-10-17 阶段 5 更新：compact 3 类与 model_anomaly_warning 已改为**logger 镜像 +
> drop 计数**（容器日志与 dropStats 双可见）；新增**压缩门**——`compact_started` 与
> `compact_completed/failed` 之间的 `model_request` / `model_complete` /
> `model_streaming` 是摘要 sidecar 请求，事件桥直接 drop（不翻译），否则摘要文本会被
> 落成 `assistant/message` 污染 surface（实测发现，样本 seq 结构
> turn/start→user→[摘要]→[真回复]）。Compact 族**不做落盘翻译**：dsh `compaction/*`
> 是驱动 surface 修剪的事务族（compaction-basic 的 compactSurfaceRegion），手工构造
> 错序会损坏 session log；引擎 auto-compact 的 dsh 等价物由 dsh-compaction-* 承担。

| 引擎事件 | 发射时机 | 载荷要点 | 丢失影响 | 处置 |
|---|---|---|---|---|
| `tool_call_started` | **每次工具执行**（`core/src/tool/executor/events.ts`） | 按执行入参解析后的副作用旗标（Bash 只读判定等） | 基本无害：旗标只服务引擎权限面（已直通）；dsh 无对应概念 | 可不接 |
| `tool_batch_complete` | **每个工具批**（`core/src/runtime/methods/tools.ts:107`） | 批内成功/失败计数 | 无害：dsh 无批概念 | 可不接 |
| `compact_started` / `compact_completed` / `compact_failed` | auto-compact 触发时（**缺省开启**；阶段 5 用 `contextWindow: 3000` 实测真实触发） | 压缩请求/摘要结果/边界 id | UI 无压缩边界感知（日志已可见）；回放把压缩前历史当全量 | **已镜像**（warn 日志 + drop；不落盘的理由见上） |
| `compact_boundary` | 压缩边界落定 | 边界消息 id | 同上 | drop 计数（不镜像） |
| `microcompact_boundary` | 工具结果微压缩（`methods/microcompact.ts`） | 微压缩边界 | 同上（工具结果大时触发） | drop 计数（不镜像） |
| `model_anomaly_warning` | 异常流检测（`methods/turn-tool-warnings.ts`） | 异常证据 | 诊断信息丢失（异常仍会体现为 turn_error） | **已镜像**（warn 日志 + drop） |
| （压缩门）`model_request` / `model_complete` / `model_streaming` | 压缩摘要 sidecar（`querySource:"compact"`） | 摘要请求/流/结果 | 无丢失——不属主 turn；翻译反而污染 surface | **门控 drop**（阶段 5） |

## 三、门控·不产生（46 种，按族）

| 族 | 类型 | 不产生的原因（对应 CAPABILITIES.md 章节） |
|---|---|---|
| 转向/队列（11） | `turn_steer_queued` / `_delivery_changed` / `_dispatch_changed` / `_drained` / `_rejected` / `_discarded` / `_reordered`、`session_input_promoted`、`queue_auto_drain_changed`、`followup_mode_changed`、`session_mode_changed` | 阶段 6 起 busy steering 走引擎 `steerTurn`，`turn_stear_queued`/`_dispatch_changed` 等**会真实发出**（drop 计数，dropStats 可见）；`_rejected` 仅空闲竞态时发出；其余队列 API 未用（§2） |
| 权限（3） | `permission_requested` / `_resolved` / `_denied` | 工具 `needsApproval:false`，引擎永不发起权限交互（§4） |
| 后台任务（3） | `background_task_started` / `_updated` / `_completed` | `runtimeTaskRegistry` 缺席（§9） |
| 子代理（3） | `subagent_spawned` / `subagent_message` / `subagent_stopped` | 子代理子系统未接（§6） |
| 动态工作流（1） | `dynamic_workflow_run_progress` | 显式关闭（§7） |
| workspace hooks（4） | `hook_run_started` / `_completed` / `_failed` / `_blocked` | `hookRunner` 缺席（§11） |
| 流式（8） | `streaming_tool_ledger_updated`、`stream_recovery_`×6、`tool_call_progress` | `modelStreaming` 已开（阶段 1）但 recovery 族仅在断流/重试时发出（实测连接稳定未出现，发出即 drop 计数）；ledger 需流中工具调度；progress 另需 MCP/进度上报方 |
| 回溯/检查点/fork（3） | `rewind_triggered`、`checkpoint_created`、`session_forked` | rewind/checkpoint/fork 未接（§8） |
| 目标环（2） | `target_changed`、`target_completion_verification` | 目标延续环未用（§14 归边缘） |
| 换模型/回退（2） | `model_selected`、`turn_execution_model_fallback` | `model_selected` 仅引擎 submission 执行态路径发射（§1 的 setSessionModelSelection 不触发）；fallback 仅执行档回退时发（发出即 drop 计数） |
| 标题（1） | `session_title_updated` | 引擎标题生成未接，dsh session-title-llm 承担（§14） |
| 网络状态（2） | `model_network_status`、`network_request_status` | 桥接 Model 不上报网络状态（model-status sink 未消费） |
| 会话生命周期（1) | `session_created` | 仅引擎自建会话路径发射，本插件不触发（§8）。（`session_resumed` 阶段 3 起随 resume 真实发出——drop 计数，实测 dropStats 可见） |
| 交互自解析（1） | `user_input_auto_resolution_updated` | 交互自解析未接（§2 边缘） |

## 四、core 无发射点（21 种）

以下类型在 `core/src` 内无发射引用，本插件路径不可能出现。其中前 9 种概念上属于
「宿主注入面」（hooks/PluginUi，对应子系统也未启用）；其余为宿主/协议层或遗留类型：

- hooks/PluginUi 注入面（9）：`workspace_hook_review_requested` / `_settled` /
  `_superseded`、`workspace_hook_admission_updated`、`plugin_ui_resource_updated` /
  `_list_changed`、`plugin_ui_instance_closed`、`plugin_ui_app_tool_call_requested`、
  `hook_run_progress`
- 宿主/遗留（12）：`turn_input_received`、`user_message`、`assistant_message`、
  `assistant_feedback_updated`、`highspeed_metrics_updated`、`system_message`、
  `model_error`、`session_ended`、`session_compacted`、`interrupt`、`cancel`、
  `resume`、`error`

（注：`user_message`/`assistant_message` 等消息类事件由本桥在翻译
`model_request`/`model_complete` 时**自行合成** dsh 的 `user/message`/
`assistant/message`——引擎不产这两个事件，落盘不缺。）

## 建议（2026-10-17 更新：均已落地）

1. ~~dropStats 打点~~：已随阶段 2 logger 接通——agent drain 每 turn 终局打
   `event-bridge drop stats`（dropped>0 时），本表静态分类已获实测校验（如
   `session_resumed`、compact 族、sidecar `model_*` 的 drop 明细均在容器日志出现）。
2. ~~Compact 族 + anomaly 补译~~：阶段 5 改判——**不做落盘翻译**（dsh `compaction/*`
   是 surface 修剪事务族，手工构造有损坏 session log 风险），改为 warn 日志镜像 +
   压缩门（见第二节更新）；tool_call_started/tool_batch_complete 维持 drop 计数。
