# 模型能力桥接：已补全项与缺口（zcode-loop 原型）

2026-10-17：生产主请求已从有效 dsh surface 派生，动态 prompt、toolHistory 和 prepared-route 准入接通；不再把“所有消息只走 blockToText”作为生产通路描述。下面保留原始模型声明／独立桥的映射依据；图片、复杂工具结果与媒体端到端验收继续归 [T08/T14](INTEGRATION-PLAN.md)，尚不宣称完成。

本文档覆盖**模型元数据层**；引擎能力层的按模块桥接盘点见
[CAPABILITIES.md](CAPABILITIES.md)，事件投影层见 [PROJECTION.md](PROJECTION.md)。

本文档记录 ZCode 引擎面 `Model` 声明（`ModelProperties` + `ModelOptionSpecs`）与 dsh llm
模型元数据（`LlmResolvedModelInfo`，经 `ctx.llm.resolveModelInfo(provider, model)` 按路由解析）
之间的映射现状：哪些已打通、哪些不支持及原因。断言见 `scripts/projection-integration.ts` AC5。

2026-10-17 补充：会话内换模型（阶段 4）起，上述取值在**每次 `model/selection` 事件**后
经 `createDshModelBridge(...).refresh({resolved})` 热更新（声明快照整体重算，对下一次
factory 调用生效）；路由本身由引擎按 turn 的 session selection 供给（selection 优先于
构造期 options）。

## 取值链（已实现）

引擎面每个字段按 **插件显式 config > dsh `resolveModelInfo` 真实元数据 > 硬编码默认** 三级取值：

| 引擎面字段 | dsh 来源 | 说明 |
|---|---|---|
| `properties.contextWindow` | `context.contextWindow` | 缺省回落 200 000 |
| `properties.inputFormat.supportsText` | — | 恒 `true` |
| `properties.supportsMidConversationSystem` | `systemPromptUpdate === 'in-history'` | 其余 `false` |
| `optionSpecs.reasoningLevel.values` | `reasoning.efforts[].id`（去重） | 目录缺席回落 `["disabled"]` |
| `optionSpecs.maxOutputTokens.max` | `defaultMaxTokens` | **语义偏差**：dsh 的是"caller 缺省时生效值"，引擎当上限用；取它作 max 保守正确。缺省回落 32 000 |

请求通路（已实现）：

- 引擎档位（`modelSelection.options.reasoningLevel`，经 `Model.bind()` 绑定；请求级
  `request.options.reasoningLevel` 优先）→ dsh `config/generateOptions.reasoningEffort`。
- `agentOptions.reasoningEffort` → 引擎 selection 档位（仅在 dsh 目录档位表内时映射，
  避免引擎按 `optionSpecs` 校验失配）。
- `request.options.maxOutputTokens` → dsh `maxTokens`。
- **物化缺省回填**：dsh `prepareCall` 会把 adapter 缺省（`defaultMaxTokens`、reasoning
  `defaultEffort`）物化进 `prepared.config`，派发 options 必须与之逐字段一致
  （`callConfigEquals`）；桥以 `withPreparedDefaults` 回填，不自行发明缺省。

## 不支持：video / audio / pdf 输入

**现状：不支持，且短期不会支持。** 原因分两侧：

dsh 侧（根本原因）：

- 模态词表只有 text/image（`ModelModalityMap`）。词表本身是 merge-extensible 的
  （插件可经 declaration merging 增加），llm 核心服务也不过滤未知模态字符串，但
  官方 deepseek adapter 只报 `['text','image']`（`llm-deepseek/src/config.ts`）。
- 原生媒体管线只有 image 一条完整链：attachment 校验归一化（PNG/JPEG/WebP/GIF）→
  `ImageBlock` → adapter 上传机制 → 请求预算与超限卸载（`LlmImageRequestBudget`）。
  attachment 包 README 明说 **"audio and video have no dedicated handling"**。
- `FileBlock` 的设计哲学是"文件永不原生到达 provider"：请求装配把 file 出现投影成
  句柄文本（名字/字节数/只读路径），模型用工具按需读。dsh 官方对非图片媒体的
  答案是 `office-to-pdf` 转换 + 只读路径工具读取，即 tools-over-native-modality。

理论上 dsh 侧插件可以补（三层成本递增）：词表合并（免费）→ 自定义 `LlmAdapter`
报出新模态并传输（一个 adapter 插件）→ 管线自带（新内容块 + attachment 归一化 +
请求装配不投影 + compaction + 预算机制，`ContentBlockMap` 注释明说新核心块要连
adapter/UI/compaction 支持落地）。若将来出现这种插件，桥侧映射是顺的
（`inputModalities` 运行时是字符串数组），只需消息翻译认识新块。

桥侧（本仓库）：`properties.inputFormat` 的 `supportsVideo/supportsAudio/supportsPdf`
恒 `false`，无来源。

## 不支持：image 输入（词表有，数据通路未落地）

dsh 侧有 image 词表与原生管线，但**桥的消息翻译只投影文本**（`blockToText` 把 image
块丢弃），inbox/session 的 attachments 也未桥接（`user/message` 只覆盖纯文本输入）。
数据通路落地前，即便 `resolveModelInfo` 报了 `inputModalities: ['text','image']`，
桥也不向引擎放行 image（`IMAGE_DATA_PATH_ENABLED = false` 门控，
`src/bridges/model-bridge.ts`）——否则引擎保留图片块后会被桥静默丢弃。

补齐需要三个桥面（节级工作）：

1. `translateMessagesToDsh`：ZCode image 块 → dsh `ImageBlock`（`ImageAttachmentRef`
   由 dsh attachment 服务持有，需把字节存入该服务取 ref）；
2. inbox：dsh followup 的 attachments → 引擎 turn 输入；
3. 事件面：`user/message` 的 attachments 落盘格式。

## 未启用：toolUpdate（工具变更随历史）

dsh 有完整的"工具集中途变更不打断 provider 前缀缓存"机制：`tool-addition`/
`tool-removal` 内容块（developer 消息）+ `GenerateOptions.toolHistory`（会话折叠账本）
+ 按路由能力 `toolUpdate: 'addition-only' | 'in-history'` 的投影
（`projectToolUpdates`）。本桥每请求发完整 `tools`、不带 `toolHistory`，机制未启用。
ZCode 引擎侧的对应策略相反：保持工具目录跨轮稳定（每请求完整列表），靠"不变"
保缓存。后果：dsh 侧工具集中途变化（插件装/卸）时，请求 tools 字段变化会打断
provider 前缀缓存。正式版若在意，可从 dsh session 的 request header 重建
`toolHistory` 喂给投影机制。

## 恒为常量的字段（dsh 无对应词表）

| 引擎面字段 | 值 | 原因 |
|---|---|---|
| `supportsToolCall` | `true` | dsh 请求面有 `tools`、loop 天然工具调用；声明 true 实际正确 |
| `supportsJsonSchemaOutput` | `false` | ZCode 独有（structured output）；引擎 `responseJsonSchema` 通路关闭 |
| `supportsNativeWebSearch` | `false` | ZCode 独有 |
| `requiresMfjsToolSchema` | `false` | ZCode 独有 |
| `outputFormat.supportsText` | `true` | dsh 流协议即文本块 |

这些不是缺口：对应的是 ZCode 引擎的可选功能开关，关闭是保守正确行为。

## 引擎/目录不对账的残留

- 引擎注入的合成 system（runtime reminder 等）只进内存请求轨迹、不落 session：
  dsh log 与 provider 请求是"有序子序列"关系，非 1:1（实测，断言按子序列写）。
- system prompt 每 agent 装配一次（构造期），dsh prompt 插件运行期改段不热更。
