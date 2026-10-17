# 事件投影层：引擎 SessionEvent → dsh SessionEvent（zcode-loop 桥接现状）

本文档覆盖**事件投影层**：vendored ZCode 引擎的 `SessionEventType`（84 种）中，
哪些被 `src/bridges/event-store-bridge.ts` 翻译成合法 dsh SessionEvent 落进
`session.v4.jsonl`，哪些被丢弃、丢弃是否有损失。它是「**哪些引擎行为 dsh 日志与
UI 永远看不到**」的契约清单。

- 引擎能力层盘点见 [CAPABILITIES.md](CAPABILITIES.md)；模型元数据层见 [GAPS.md](GAPS.md)。
- 版本锚定与 [CAPABILITIES.md](CAPABILITIES.md#版本锚定) 相同：ZCode 快照 v3.15.1、
  vendored 基准 commit `4a836e6`、`vendor/zcode/` 与 `reference/` 逐字节一致；
  **vendor 升级时本文档需重盘**。盘点日期 2026-10-16。

## 口径

| 分类 | 数量 | 含义 |
|---|---|---|
| 已翻译 | 9 | 事件桥有 case，落为合法 dsh 事件 |
| **会发出·被丢** | 8 | 当前引擎配置下**真实发出**、桥按未知类型丢弃——有感知损失的集合 |
| 门控·不产生 | 46 | 对应子系统/端口未启用，事件根本不会发出 |
| core 无发射点 | 21 | core 内无发射引用（宿主/协议层注入或遗留类型），本插件路径不可能出现 |
| 合计 | **84** | contracts `SessionEventType` 全集 |

分类方法：静态核查（发射点引用 + 子系统启用条件）；个别类型的动态行为以桥的
`dropStats()` 实测为准（该统计当前只在内存，见文末建议）。

## 一、已翻译的 9 种（引擎事件 → dsh 落盘事件）

| 引擎事件 | 桥的翻译 | dsh 落盘事件 |
|---|---|---|
| `turn_started` | 记 turn、user 文本暂存 | `turn/start` |
| `model_request` | 上一步缓冲落定 + 开新步；首个请求落 system（前导 system 拼接为一条） | `step/end`(若有) → `step/start` → `system/message`(仅首个) → `user/message` → `request/header` |
| `model_streaming` | 不直接落盘；累积为紧凑流 | （折进 `assistant/message` 的 `stream` 字段） |
| `model_complete` | 缓冲 assistant | （等工具调度或下一边界 flush 成 `assistant/message`） |
| `tool_call_scheduled` | 缓冲 assistant（含 tool-call 块）先落定 | `assistant/message` → `tool/call` |
| `tool_call_result` | 按 callId 序号回联 | `tool/result`（`isError` 按 `success`） |
| `tool_call_error` | 错误文案与元数据 | `tool/result`（`isError:true` + `error`） |
| `turn_complete` | 缓冲落定 + 收口 | `assistant/message`(若有) → `step/end`(若 open) → `turn/end`{completed} |
| `turn_error` | 同上错误路径 | → `turn/end`{error} |

缓冲不是丢失：是 v4 关系校验要求的翻译排序（assistant 必须先于其 tool 结果进入
surface）。`model_streaming` 当前收不到数据（引擎非流式，见 CAPABILITIES.md §1），
但翻译逻辑已实现——开流式后立即生效。

## 二、会发出·被丢（现实缺口，8 种）

| 引擎事件 | 发射时机 | 载荷要点 | 丢失影响 | 处置 |
|---|---|---|---|---|
| `tool_call_started` | **每次工具执行**（`core/src/tool/executor/events.ts`） | 按执行入参解析后的副作用旗标（Bash 只读判定等） | 基本无害：旗标只服务引擎权限面（已直通）；dsh 无对应概念 | 可不接 |
| `tool_batch_complete` | **每个工具批**（`core/src/runtime/methods/tools.ts:107`） | 批内成功/失败计数 | 无害：dsh 无批概念 | 可不接 |
| `compact_started` / `compact_completed` / `compact_failed` | auto-compact 触发时（**缺省开启**） | 压缩请求/摘要结果 | **有感知损失**：dsh 日志与 UI 看不到压缩边界，回放把压缩前历史当全量 | **建议接入**（CAPABILITIES.md 接入顺序第 5 项） |
| `compact_boundary` | 压缩边界落定 | 边界消息 id | 同上 | 同上 |
| `microcompact_boundary` | 工具结果微压缩（`methods/microcompact.ts`） | 微压缩边界 | 同上（工具结果大时触发） | 同上 |
| `model_anomaly_warning` | 异常流检测（`methods/turn-tool-warnings.ts`） | 异常证据 | 诊断信息丢失（异常仍会体现为 turn_error） | 随 logger 接通一起评估 |

## 三、门控·不产生（46 种，按族）

| 族 | 类型 | 不产生的原因（对应 CAPABILITIES.md 章节） |
|---|---|---|
| 转向/队列（11） | `turn_steer_queued` / `_delivery_changed` / `_dispatch_changed` / `_drained` / `_rejected` / `_discarded` / `_reordered`、`session_input_promoted`、`queue_auto_drain_changed`、`followup_mode_changed`、`session_mode_changed` | 插件不走引擎转向/队列 API（§2） |
| 权限（3） | `permission_requested` / `_resolved` / `_denied` | 工具 `needsApproval:false`，引擎永不发起权限交互（§4） |
| 后台任务（3） | `background_task_started` / `_updated` / `_completed` | `runtimeTaskRegistry` 缺席（§9） |
| 子代理（3） | `subagent_spawned` / `subagent_message` / `subagent_stopped` | 子代理子系统未接（§6） |
| 动态工作流（1） | `dynamic_workflow_run_progress` | 显式关闭（§7） |
| workspace hooks（4） | `hook_run_started` / `_completed` / `_failed` / `_blocked` | `hookRunner` 缺席（§11） |
| 流式（8） | `streaming_tool_ledger_updated`、`stream_recovery_`×6、`tool_call_progress` | `modelStreaming` 未开（§1）；progress 另需 MCP/进度上报方 |
| 回溯/检查点/fork（3） | `rewind_triggered`、`checkpoint_created`、`session_forked` | rewind/checkpoint/fork 未接（§8） |
| 目标环（2） | `target_changed`、`target_completion_verification` | 目标延续环未用（§14 归边缘） |
| 换模型/回退（2） | `model_selected`、`turn_execution_model_fallback` | 运行期换模型未接（§1） |
| 标题（1） | `session_title_updated` | 引擎标题生成未接，dsh session-title-llm 承担（§14） |
| 网络状态（2） | `model_network_status`、`network_request_status` | 桥接 Model 不上报网络状态（model-status sink 未消费） |
| 会话生命周期（2） | `session_created`、`session_resumed` | 仅 `resumeFromStore` 路径发射（`methods/resume.ts`），本插件不调（§8） |
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

## 建议

1. `dropStats()` 目前只在内存（诊断需打点）。**随 logger 接通（CAPABILITIES.md 接入
   顺序第 2 项）把 dropStats 周期性/终局打到 dsh 日志面**，让本表的静态分类获得
   实测校验。
2. 真正值得补译的只有 Compact 族 5 种 + `model_anomaly_warning`（共 6 种）；其余
   「会发出·被丢」两类（tool_call_started/tool_batch_complete）无 dsh 对应概念，
   维持丢弃并保留 dropStats 计数即可。
