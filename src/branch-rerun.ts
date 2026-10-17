/**
 * 目标边界重跑：从父会话目标 turn 之前的已完成边界派生独立分支，并把编辑后的
 * 输入作为分支自己的第一条 `user/message`。
 *
 * 约束：
 * - 边界取「目标 user 消息所属 turn 的 turn/start 之前最近的 turn/end」（包含式）：
 *   目标及之后的 turn 一律不进入 seed；父日志只读，不截断。
 * - seed 由 `buildForkSeed` 收口（前缀 + `session/end-seed` + open-tail closers），
 *   `inheritedEventCount` 只统计复制的前缀（boundary + 1）。
 * - 编辑文本落在继承标记之后，是子会话 own event；子会话与 /sidechat 一样是
 *   独立 seeded create，不声明 subagent origin，也不自动驱动。
 * - `parentSession`/`isSeeded` 走 dsh session header；header 只保留白名单字段，
 *   因此 `rerunFrom`（目标消息 seq/边界 seq）另以 ignorable plugin record 落盘。
 * - 全程不触碰文件：不调用工作区快照/回滚，分支只新增会话事件。
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  appendPluginRecord,
  SessionId as DshSessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { buildForkSeed } from "@deepseek-ai/dsh-session/fork";

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap {
    "plugin:zcode-loop/rerun": {
      parentSession: string;
      messageSeq: number;
      boundarySeq: number;
      messageNumber: number;
    };
  }
}

export const BRANCH_RERUN_USAGE = "Usage: /rerun <message-number>|last <edited text>";

/** 命令入参：第 N 条 user/message（1-based）或最后一条。 */
export type BranchRerunTarget =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "last" };

export interface BranchRerunRequest {
  readonly target: BranchRerunTarget;
  readonly editedText: string;
}

export interface BranchRerun {
  /** 新建的独立分支会话 id。 */
  sessionId: DshSessionId;
  /** 父会话已完成 turn 的包含式边界（目标 turn 之前最近的 turn/end）。 */
  boundary: number;
  /** 被重跑的目标 user/message seq。 */
  targetSeq: number;
  /** 目标在父会话 user/message 序列中的序号（1-based）。 */
  messageNumber: number;
  /** 子会话继承的父前缀事件数（不含继承标记与收口）。 */
  inheritedEventCount: number;
}

/**
 * 解析 `/rerun` 的 rawInput。无法构成完整请求时返回 undefined，由命令层回
 * 统一 usage；不做任何会话副作用。
 */
export function parseBranchRerunInput(rawInput: string): BranchRerunRequest | undefined {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) return undefined;
  const separator = trimmed.search(/\s/u);
  const selector = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const editedText = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (editedText.length === 0) return undefined;
  if (selector === "last") return { target: { kind: "last" }, editedText };
  if (!/^[1-9]\d*$/u.test(selector)) return undefined;
  const index = Number(selector);
  if (!Number.isSafeInteger(index)) return undefined;
  return { target: { kind: "index", index }, editedText };
}

/** 目标 user/message 所属 turn 的 turn/start（按包含关系判定，跨 turn/end 即重置）。 */
function containingTurnStart(
  events: readonly SessionEvent[],
  targetSeq: number,
): SessionEvent | undefined {
  let turnStart: SessionEvent | undefined;
  for (const event of events) {
    if (event.seq >= targetSeq) break;
    if (event.type === "turn/start") turnStart = event;
    else if (event.type === "turn/end") turnStart = undefined;
  }
  return turnStart;
}

/**
 * 从父会话目标输入之前的已完成边界创建独立重跑分支。
 *
 * @param ctx - 持有 `agents` 服务的宿主上下文（seeded create 走已注册工厂）。
 * @param parent - 发起命令的父 agent。
 * @param request - 已解析的目标序号/编辑文本。
 * @param signal - 命令调用取消信号。
 */
export async function createBranchRerun(
  ctx: Context,
  parent: Agent,
  request: BranchRerunRequest,
  signal: AbortSignal,
): Promise<BranchRerun> {
  const events = parent.session.snapshotEvents();
  // 序号只数人类输入（source.kind==="user"）：plan/goal/runtime-context 等同样
  // 落 user/message，但不是用户可重跑的输入，不能占用 ``/rerun <n>`` 的序号。
  const userMessages = events.filter(
    (event) =>
      event.type === "user/message" &&
      (event.data as { source?: { kind?: unknown } }).source?.kind === "user",
  );
  const targetEvent =
    request.target.kind === "last"
      ? userMessages.at(-1)
      : userMessages[request.target.index - 1];
  if (targetEvent === undefined) {
    throw new Error(
      `Rerun target user message ${
        request.target.kind === "last" ? "last" : request.target.index
      } not found in parent ${parent.id} (${userMessages.length} user message(s)). ${BRANCH_RERUN_USAGE}`,
    );
  }
  const sourceKind = (targetEvent.data as { source?: { kind?: unknown } }).source?.kind;
  if (sourceKind !== "user") {
    const label =
      request.target.kind === "last" ? "last" : String(request.target.index);
    throw new Error(
      `Rerun target message ${label} (seq ${targetEvent.seq}) is not a user input; source.kind="${String(
        sourceKind,
      )}". ${BRANCH_RERUN_USAGE}`,
    );
  }

  const turnStart = containingTurnStart(events, targetEvent.seq);
  if (turnStart === undefined) {
    throw new Error(
      `Rerun target user message (seq ${targetEvent.seq}) is not inside an open turn. ${BRANCH_RERUN_USAGE}`,
    );
  }
  // 目标 turn 之前最近的已完成 turn；目标 turn 自身及之后绝不进入 seed。
  const previousTurnEnd = events
    .filter((event) => event.type === "turn/end" && event.seq < turnStart.seq)
    .at(-1);
  if (previousTurnEnd === undefined) {
    throw new Error(
      `Rerun target turn has no completed turn before it; nothing can be forked. ${BRANCH_RERUN_USAGE}`,
    );
  }
  const boundary = previousTurnEnd.seq;
  const seed = buildForkSeed(events, SessionSeq(boundary));

  // 编辑文本是子会话自己的输入：继承标记/收口之后才追加，保持 own event 语义。
  const editedMessage = createUserMessage({
    content: [{ type: "text", text: request.editedText }],
    source: { kind: "user" },
  });
  seed.push({
    type: "user/message",
    seq: SessionSeq(seed.length),
    time: Date.now(),
    data: editedMessage,
    surfaceOp: "append",
  } satisfies SessionEvent);

  const header = parent.session.header;
  const messageNumber =
    request.target.kind === "last"
      ? userMessages.length
      : request.target.index;
  const rerunFrom = {
    messageSeq: targetEvent.seq,
    boundarySeq: boundary,
    messageNumber,
  };
  // meta 在创建期可观察；dsh session header 只持久化白名单字段，rerunFrom 另以
  // plugin record 落到子会话日志，保证 durable target 标记不依赖进程内状态。
  const meta = {
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    parentSession: header.id,
    isSeeded: true,
    rerunFrom,
  } satisfies CreateAgentOptions["meta"] & { rerunFrom: typeof rerunFrom };
  const agentOptions = {
    ...(parent.options.provider === undefined ? {} : { provider: parent.options.provider }),
    ...(parent.options.model === undefined ? {} : { model: parent.options.model }),
    ...(parent.options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: parent.options.reasoningEffort }),
  };
  const sessionId = DshSessionId(`rerun-${randomUUID()}`);
  signal.throwIfAborted();
  const handle = await ctx.agents.create({
    sessionId,
    seed,
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta,
    agentOptions,
    signal,
  });
  appendPluginRecord(handle.agent.session, "plugin:zcode-loop/rerun", {
    ...rerunFrom,
    parentSession: header.id,
  });
  return {
    sessionId,
    boundary,
    targetSeq: targetEvent.seq,
    messageNumber,
    inheritedEventCount: boundary + 1,
  };
}
