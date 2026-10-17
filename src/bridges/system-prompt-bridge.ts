/**
 * dsh prompt assembly and prepared-route admission.
 * The exported minimal context builder seeds the engine; production dispatch
 * commits current dsh instructions/facts and derives messages from its surface.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import type { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { renderPrompt, renderContextSections, joinContextSections } from "@deepseek-ai/dsh-system-prompt";
import { createSystemMessage, createUserMessage, type UserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";

import type { ContextBuildResult } from "../engine-facade.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap { "runtime-context": { kind: "runtime-context" } & ContextFormed }
}

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

/** dsh owns dynamic instructions and facts; decisions are committed only after prepareCall. */
export class DshPromptAdmission {
  constructor(private readonly ctx: Context, private readonly agent: Agent) {}

  assemble(signal: AbortSignal): Promise<PromptAssembly> {
    return this.ctx.systemPrompt.assemble(assembleContextFor(this.agent, signal));
  }

  context(assembly: PromptAssembly, signal: AbortSignal): UserMessage | undefined {
    const refreshed = this.ctx.systemPrompt.refreshContext(assembly, assembleContextFor(this.agent, signal));
    const sections = renderContextSections(refreshed);
    const current = joinContextSections(sections);
    const previous = this.agent.session.deriveMessages().findLast(message => message.role === "user" && message.source.kind === "runtime-context");
    if (!previous && !current) return;
    const text = current || "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";
    if (previous && JSON.stringify(previous.content) === JSON.stringify([{ type: "text", text }])) return;
    return createUserMessage({ content: [{ type: "text", text }], source: sections.length
      ? { kind: "runtime-context", form: "snapshot", sections } : { kind: "runtime-context" } });
  }

  commit(assembly: PromptAssembly, position: { turn: number; step: number }, inHistory: boolean, startsSeries: boolean): void {
    const session = this.agent.session;
    const text = renderPrompt(assembly);
    const nodes = session.surface.nodes.flatMap(seq => {
      const event = session.eventAt(seq);
      return event?.type === "system/message" ? [{ seq, message: event.data.message }] : [];
    });
    const head = nodes[0];
    const textOf = (message: { content: readonly unknown[] }) => message.content.length === 0 ? "" :
      message.content.map(block => (block as { text?: string }).text ?? "").join("");
    const replace = (seq: number, next: string) => session.append("system/message", { ...position, message: createSystemMessage(next) }, {
      surfaceOp: { op: "replace", startSeq: SessionSeq(seq), endSeq: SessionSeq(seq) }, sourceEventSeqs: [SessionSeq(seq)],
    });
    if (!head) {
      session.append("system/message", { ...position, message: createSystemMessage(text) }, { surfaceOp: "append" });
      return;
    }
    if (!inHistory || startsSeries || !text) {
      for (const node of nodes.slice(1)) if (textOf(node.message)) replace(node.seq, "");
      if (textOf(head.message) !== text) replace(head.seq, text);
    } else if (textOf(nodes.findLast(node => textOf(node.message))?.message ?? head.message) !== text) {
      session.append("system/message", { ...position, message: createSystemMessage(text) }, { surfaceOp: "append" });
    }
  }
}
