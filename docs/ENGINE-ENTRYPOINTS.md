# ZCode 能力入口统计

`pnpm verify:contracts` 同时输出两项独立结论：**执行过的场景差分**与**引擎能力接入状态**。三个场景的 `bridge-gap: 0` 不能作为全量桥接缺口数；当前总状态为 `INCOMPLETE`。

```sh
pnpm verify:contracts
pnpm verify:contracts --strict-integration
# 仅重新扫描能力入口，不调用模型、不运行三个场景：
pnpm verify:capabilities
pnpm verify:capabilities --strict-integration
pnpm verify:capabilities:selftest
```

默认报告目录为 `.agent-work/tmp/contract-classification/report/`。入口总览在 `index.html`，完整能力分组、逐条声明、签名指纹、生产接缝与来源位置在 `capabilities.html` / `capabilities.json`，另有 `capabilities.md`。独立能力命令只刷新 `capabilities.*`；场景总览需运行组合命令刷新。

## 扫描与分类

TypeScript AST 从当前 vendor 源码机械提取：

- `AgentRuntime` 的公开接口及公开类成员；
- `AgentRuntimeConfig` / `AgentRuntimeDeps` 字段；
- `ExecuteTurnOptionsBase` / `PromptAdmissionOptions` 自有字段；
- `MemoryRuntimeConfig` / `AutoCompactPolicyConfig` 字段；
- `builtInTools` 注册清单的工具条目。

这是接口、配置、端口、工具的条目统计，**不是独立功能数量**。分组及处置依据存于 `scripts/contract-verification/capabilities.json`；扫描器不会靠名称猜测语义，也不会根据场景通过自动填写“已接通”。

| 分类 | 含义 |
| --- | --- |
| 已桥接 | 生产桥已有接线；不自动等于语义无损或已运行全部行为。 |
| 引擎内部默认生效 | 核心循环会使用的内部行为/默认构件，不需要额外宿主调用。可调参数没有入口时仍另外列为未接入。 |
| dsh 已有替代 | 有具体 dsh 工具、服务或本桥宿主实现承担通用功能，并附源码证据。仅为静态依据，不表示当前 profile 已激活，更不保证 ZCode 专属协议逐项等价。 |
| 未接入 | 引擎有接口/配置/工具，但桥未提供入口，或通用替代未覆盖其专属语义。此前的“边缘／不需要”不能成为排除理由。 |
| 无法直接桥接（当前宿主） | 当前 dsh 消费契约无法直接承接，需扩展宿主或新增适配/插件。不是声称永远无法实现。 |
| 待评估 | 新增或签名变化、不能沿用旧分类；检查失败。 |

例如 rewind、检查点/文件回滚、项目记忆、选区旁路会话、引擎手动 compact、hooks、node_repl、off-peak 及动态工作流专属操作均有明确未接入项。普通 dsh fork、工作流、工具 hooks 或 schedule 的存在不会把这些专属接口消去。

当前“无法直接桥接”分为 ZCode agent telemetry collector 与 trace/span 会话结构化投影两组，限制和来源随报告保留。普通 dsh 遥测与日志输出不等于接通了 ZCode 的同一消费协议。

## 漂移与退出码

每个已分类条目绑定其声明签名 SHA256；生产 `runtime.*` 调用和 `createEmbeddedEngine` 装配语法也有指纹。新增条目、删除条目、签名变化或生产接缝变化会显式报错；重复归类、丢失来源文本也会失败。行号移动不会使声明指纹变化。新入口落地后，应更新**对应分组及证据**，不能批量把新发现归为有意差异或替代。

| 退出码 | 含义 |
| --- | --- |
| 0 | 扫描/执行成功，没有未解释变化。允许已明确列出的未接入项，因此总状态仍可能是 `INCOMPLETE`。 |
| 1 | 场景真实差异、未知能力、声明/接缝漂移、无效证据或执行失败。 |
| 2 | 其余检查通过，但 `--strict-integration` 拒绝剩余未接入/无法直接桥接项，或 `--strict-coverage` 拒绝场景覆盖不足。 |

`check.json.status` 是总状态，`scenarioStatus` 才是三个场景的结果；`capabilityInventory` 表示清单检查，`capabilityIntegration` 表示接入程度。`inventory PASS` 仅代表扫描结果都已有处置记录。

## 边界

这是最小静态入口盘点，不是全程序可达性证明。扫描不穷举内部函数、递归展开所有外部引用类型或推断任意别名/动态反射调用；生产接缝定位针对当前使用的 `runtime.*` 与 `createEmbeddedEngine` 形态。内联配置变化会改变签名，memory/compact 引用配置单独展开，其余引用类型的内部变化仍需专项检查。源码实现体变化和运行期插件激活也不由签名分类证明。

行为覆盖仍由原来的场景、consumer 回归和浏览器验收单独提供。两项统计共同展示，任何一项都不能代替另一项。
