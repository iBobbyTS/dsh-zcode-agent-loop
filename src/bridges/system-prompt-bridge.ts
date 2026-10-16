/**
 * system-prompt-bridge — S03 的 dsh system prompt 注入。
 *
 * 任务合同要求"contextBuilder 用最小实现把 dsh `SystemPrompt.assemble()` 结果
 * 注入 system 消息"。现场实测（vendored `runtime/methods/turn.ts` +
 * `context-refresh.ts`）：**注入的 `deps.contextBuilder` 活不过第一个 turn** ——
 * 引擎在每个 turn 开始时 `rebuildContextPrefix()` 无条件用
 * `createContextBuilderFromSnapshot()`（stock ContextBuilder）替换它，custom
 * builder 的 build() 结果永远到不了 provider 请求。
 *
 * 每轮存活的等价接缝是 `AgentRuntimeConfig.systemPrompt`（stock builder 的
 * `customSystemPrompt` 路径，每次 rebuild 都从 `this.config` 重读）：
 * - custom prompt 在场时 stock builder **跳过整个默认动态 system 段**
 *   （identity/dynamic behavior/session guidance/memory/env info/output style/
 *   context management/git context —— 即"禁 ZCode 内建 reminders"）；
 * - 残留的 turn 级 reminder（todo reminder）以工具在场为门，外壳已用
 *   `toolAllowlist: []` 关闭全部内建工具，门不开；
 * - 仍会保留 cli_prefix 身份行（引擎无条件注入，无配置门）——原型接受并在
 *   HANDOFF 声明。
 *
 * 本模块因此提供两条互补件：
 * 1. {@link assembleDshSystemPrompt}：`ctx.systemPrompt.assemble()` →
 *    `renderPrompt()` 的最小装配（dsh 段落即全部 system 内容）；
 * 2. {@link createDshContextBuilder}：最小 ContextBuilder 实现（把同一段文本
 *    作为唯一 system 消息返回）。它只服务引擎构造期的 messageHistory 初始化
 *    （随即被首轮 rebuild 取代——保留它是为了让"注入的是 dsh prompt"这一事实
 *    在构造期也成立，且形状上兑现任务合同的 contextBuilder 最小实现）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import type { AssembleContext } from "@deepseek-ai/dsh-system-prompt";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

import type { ContextBuildResult } from "../engine-facade.js";

/** dsh system prompt 的最小装配结果。 */
export interface DshSystemPromptAssembly {
  /** `renderPrompt(assembly)`：dsh 段落渲染出的完整 system prompt 文本。 */
  prompt: string;
}

/**
 * 装配 dsh system prompt（`ctx.systemPrompt.assemble()` → `renderPrompt()`）。
 * agent 在场时按其 scope 装配（对齐 stock loop 的 `assembleContextFor(agent)`）。
 */
export async function assembleDshSystemPrompt(
  ctx: Context,
  agent?: Agent,
  signal?: AbortSignal,
): Promise<DshSystemPromptAssembly> {
  const context: AssembleContext =
    agent !== undefined
      ? assembleContextFor(agent, signal)
      : signal !== undefined
        ? { signal }
        : {};
  const assembly = await ctx.systemPrompt.assemble(context);
  return { prompt: renderPrompt(assembly) };
}

/**
 * 最小 contextBuilder：build() 只产出一条 system 消息（dsh 装配文本）。
 * 注意（见模块头）：引擎每轮 rebuild 会用 stock builder 替换本对象；真正进入
 * 请求的等价注入走 `config.systemPrompt`（外壳负责同值设置）。
 *
 * 返回值需要一次显式断言才能进 `deps.contextBuilder`（vendored ContextBuilder
 * 是带私有字段的 class 类型，结构兼容无法自动成立）——断言发生在调用方
 * （`src/index.ts`），本函数只保证 build() 形状与 ContextBuildResult 一致。
 */
export function createDshContextBuilder(assembly: DshSystemPromptAssembly): {
  build(): ContextBuildResult;
} {
  const build = (): ContextBuildResult => ({
    sections: [],
    totalChars: assembly.prompt.length,
    // 粗估（每 4 字符 1 token），只为填满结构字段；不参与任何决策。
    totalTokens: Math.ceil(assembly.prompt.length / 4),
    systemMessages:
      assembly.prompt.length > 0
        ? [{ role: "system", content: assembly.prompt }]
        : [],
    metaUserAttachments: [],
  });
  return { build };
}
