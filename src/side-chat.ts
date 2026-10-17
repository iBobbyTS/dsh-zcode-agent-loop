/**
 * 选区侧聊：从父会话的已完成前缀 + 选区文本派生一个独立 dsh 子会话。
 *
 * 约束：
 * - 只取最后一条 `turn/end` 及其之前的事件（`buildForkSeed` 负责继承标记与
 *   开放尾收口）；父会话进行中的工具/未提交内容不进入 seed。
 * - 选区文本作为子会话自己的第一条 `user/message` 追加在继承前缀之后，因此
 *   `inheritedEventCount` 仍等于父前缀长度，子会话按普通 seeded create 水合。
 * - 子会话只声明 durable `parentSession`（会话树关系），不伪造 subagent origin
 *   或 descriptor；它不是受 subagent 管理器接管的委派执行。
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  SessionId as DshSessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { buildForkSeed } from "@deepseek-ai/dsh-session/fork";

export interface SelectionSideChat {
  /** 新建的独立子会话 id。 */
  sessionId: DshSessionId;
  /** 父会话已完成前缀的包含式边界。 */
  boundary: number;
  /** 子会话继承的事件数（父前缀 + 继承标记）。 */
  inheritedEventCount: number;
}

/**
 * 以父会话已完成前缀 + 选区文本创建独立侧聊子会话。
 *
 * @param ctx - 持有 `agents` 服务的宿主上下文（seeded create 走已注册工厂）。
 * @param parent - 发起命令的父 agent。
 * @param selection - 用户在父会话中选中的文本，作为子会话首条 user 消息。
 * @param signal - 命令调用取消信号。
 */
export async function createSelectionSideChat(
  ctx: Context,
  parent: Agent,
  selection: string,
  signal: AbortSignal,
): Promise<SelectionSideChat> {
  const events = parent.session.snapshotEvents();
  const lastTurnEnd = events.findLast((event) => event.type === "turn/end");
  if (lastTurnEnd === undefined) {
    throw new Error("side chat requires at least one completed turn in the parent session");
  }
  const boundary = lastTurnEnd.seq;
  const seed = buildForkSeed(events, SessionSeq(boundary));
  // 选区是子会话自己的输入，必须落在继承标记/收口之后，才算 own event。
  const selectionMessage = createUserMessage({
    content: [{ type: "text", text: selection }],
    source: { kind: "user" },
  });
  const selectionEvent = {
    type: "user/message",
    seq: SessionSeq(seed.length),
    time: Date.now(),
    data: selectionMessage,
    surfaceOp: "append",
  } satisfies SessionEvent;
  seed.push(selectionEvent);

  const header = parent.session.header;
  const agentOptions = {
    ...(parent.options.provider === undefined ? {} : { provider: parent.options.provider }),
    ...(parent.options.model === undefined ? {} : { model: parent.options.model }),
    ...(parent.options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: parent.options.reasoningEffort }),
  };
  const sessionId = DshSessionId(`sidechat-${randomUUID()}`);
  signal.throwIfAborted();
  await ctx.agents.create({
    sessionId,
    seed,
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta: {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      parentSession: header.id,
      isSeeded: true,
    },
    agentOptions,
    signal,
  });
  return { sessionId, boundary, inheritedEventCount: boundary + 1 };
}
