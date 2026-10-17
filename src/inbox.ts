/** Durable inbox commands and the stock-compatible public session projection.
 * The session splice log is the authority, including seeded/resumed pending input.
 * The queue uses the same fold with a local watermark when projections are absent.
 */
import type { ContentBlock, MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Inbox, InboxState, InboxTarget, InboxWireState } from "@deepseek-ai/dsh-agent";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { Session as DshSession, SessionEventMap } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";

const inboxProjectionSchema = z.object({
  "next-turn": z.array(z.custom<UserMessage>()).readonly(),
  "next-step": z.array(z.custom<UserMessage>()).readonly(),
}).readonly();

/** Strict durable coordinates; commands normalize JavaScript splice input first. */
function foldInboxSplice(state: InboxState, splice: SessionEventMap["agent/inbox/spliced"]): InboxState {
  const inbox = state[splice.target];
  const removedCount = splice.removedCount ?? 0;
  if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
    || !Number.isSafeInteger(removedCount) || removedCount < 0
    || splice.start + removedCount > inbox.length) {
    throw new Error("invalid inbox splice");
  }
  const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted);
  const ids = new Set<string>();
  for (const message of splice.target === "next-turn"
    ? [...next, ...state["next-step"]]
    : [...state["next-turn"], ...next]) {
    if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
    ids.add(message.id);
  }
  return splice.target === "next-turn"
    ? { "next-turn": next, "next-step": state["next-step"] }
    : { "next-turn": state["next-turn"], "next-step": next };
}

/** Required private stock definition semantics; no second loop or internal import. */
export const inboxProjectionDefinition = {
  key: "inbox",
  stateVersion: 1,
  // Host registry uses zod 4.4; the plugin uses 4.6. Bridge their nominal schema types.
  stateSchema: inboxProjectionSchema as unknown as ProjectionDefinition<"inbox", InboxState>["stateSchema"],
  init: (): InboxState => ({ "next-turn": [], "next-step": [] }),
  apply(state: InboxState, event) {
    if (event.type !== "agent/inbox/spliced") return state;
    try {
      return foldInboxSplice(state, event.data);
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error });
    }
  },
  wire: {
    viewSchema: inboxProjectionSchema as unknown as NonNullable<ProjectionDefinition<"inbox", InboxState>["wire"]>["viewSchema"],
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
} satisfies ProjectionDefinition<"inbox", InboxState>;

/**
 * 消息文本投影（兼容旧调用：只投影文本，非 text 块给可读占位）。
 * 真实 turn 输入走 `buildDshUserInput`：image 进入引擎宿主附件通道，file 保留
 * 引用文本；本函数保留给纯文本诊断面。
 */
export function userMessageText(message: UserMessage): string {
  const content: readonly ContentBlock[] = message.content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
    .join("\n");
}

/** inbox live 事件词表（stock 同款；emit 只传实际 payload，无 agent 字段）。 */
export type InboxLiveEvent =
  | "agent/inbox/inserted"
  | "agent/inbox/claimed"
  | "agent/inbox/discarded";

export class ZcodeLoopInbox implements Inbox {
  private state: InboxState = inboxProjectionDefinition.init();
  private foldedCount = 0;

  constructor(
    private readonly session: DshSession,
    /**
     * 阶段 6：live 事件出口（agent 构造时转发进 dsh AgentEventDispatch）。
     * claimed 的 `turn` 是拥有该批的 turn 号；inserted/discarded 无 turn 语义。
     */
    private readonly emitLive?: (event: InboxLiveEvent, payload: { message: UserMessage; turn?: number }) => void,
  ) {
    this.current();
  }

  get nextTurn(): readonly UserMessage[] {
    return this.current()["next-turn"];
  }

  get nextStep(): readonly UserMessage[] {
    return this.current()["next-step"];
  }

  get hasPending(): boolean {
    return this.current()["next-turn"].length > 0 || this.current()["next-step"].length > 0;
  }

  /** 持久清空全部 pending（next-step 先于 next-turn，写 canceled splice）。 */
  clear(): void {
    this.splice("next-step", 0, this.nextStep.length, []);
    this.splice("next-turn", 0, this.nextTurn.length, []);
  }

  /**
   * 取走一个 turn 的批：全部 next-step + 一条 next-turn（stock claim 语义）。
   * 取走也落 splice（不带 canceled outcome——被消费不是被取消）。
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const nextStep = this.normalize("next-step", 0, this.current()["next-step"].length, [], false);
    const nextTurn = target === "next-turn"
      ? this.normalize("next-turn", 0, 1, [], false)
      : undefined;
    if (nextStep === undefined && nextTurn === undefined) return [];
    // 两个 splice 先对同一候选状态一起校验再落盘：任一批非法时不得吞掉另一批。
    let candidate = this.current();
    if (nextStep !== undefined) candidate = foldInboxSplice(candidate, nextStep);
    if (nextTurn !== undefined) candidate = foldInboxSplice(candidate, nextTurn);
    const claimed: UserMessage[] = [];
    if (nextStep !== undefined) claimed.push(...this.commitSplice(nextStep, false, turn));
    if (nextTurn !== undefined) claimed.push(...this.commitSplice(nextTurn, false, turn));
    return claimed;
  }

  /** Claim only a committed tool result's contexts; leave other queued inputs alone. */
  claimMessages(ids: readonly MessageId[], turn: number): UserMessage[] {
    const claimed: UserMessage[] = [];
    for (const id of ids) {
      const index = this.current()["next-step"].findIndex((message) => message.id === id);
      if (index >= 0) claimed.push(...this.apply("next-step", index, 1, [], false, turn));
    }
    return claimed;
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message]);
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message]);
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId);
    if (location === undefined) return false;
    this.splice(location.target, location.index, 1, [newMessage]);
    return true;
  }

  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId);
    if (location === undefined) return false;
    this.splice(location.target, location.index, 1, []);
    return true;
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    // splice 路径不产生 claimed 事件（discardRemoved=true → 全走 discarded），turn 恒 0。
    return this.apply(target, start, deleteCount, inserted, true, 0);
  }

  /** Replay each committed event once, including seed and writes from other facades. */
  private current(): InboxState {
    for (const event of this.session.snapshotEvents(SessionLogOffset(this.foldedCount))) {
      this.state = inboxProjectionDefinition.apply(this.state, event);
      this.foldedCount += 1;
    }
    return this.state;
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ["next-turn", "next-step"] as const) {
      const index = this.current()[target].findIndex((message) => message.id === messageId);
      if (index >= 0) return { target, index };
    }
    return undefined;
  }

  /**
   * 归一化 splice → 内存折叠 + `agent/inbox/spliced` 落盘（唯一真相）+ live 事件
   * （阶段 6，与落盘同一次状态变更）：被移除且 discardRemoved（canceled，即
   * clear/覆盖删除）→ discarded；被移除且非 canceled（claim 消费）→ claimed
   * {turn}（stock 同款：claim 的 removed 批记到拥有它的 turn 上）；插入的每条 →
   * inserted。事件序与 stock 对齐：先移除侧后插入侧。
   */
  private apply(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
    turn: number,
  ): UserMessage[] {
    const splice = this.normalize(target, start, deleteCount, inserted, discardRemoved);
    if (splice === undefined) return [];
    return this.commitSplice(splice, discardRemoved, turn);
  }

  /** 归一化一次 splice；空操作返回 undefined（不落盘、不发 live 事件）。 */
  private normalize(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): SessionEventMap["agent/inbox/spliced"] | undefined {
    const inbox = this.current()[target];
    const truncatedStart = Math.trunc(start);
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart;
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length);
    const truncatedDeleteCount = Math.trunc(deleteCount);
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    );
    if (actualDeleteCount === 0 && inserted.length === 0) return undefined;
    const outcome = discardRemoved && actualDeleteCount > 0 ? ("canceled" as const) : undefined;
    return {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    };
  }

  /** 校验并持久化已归一化的 splice，随后发布 live 事件。 */
  private commitSplice(
    splice: SessionEventMap["agent/inbox/spliced"],
    discardRemoved: boolean,
    turn: number,
  ): UserMessage[] {
    const inbox = this.current()[splice.target];
    foldInboxSplice(this.current(), splice); // Reject duplicate commands before persisting.
    const event = this.session.append("agent/inbox/spliced", splice);
    this.current();
    const removed = inbox.slice(splice.start, splice.start + (splice.removedCount ?? 0));
    for (const message of removed) {
      if (discardRemoved) this.emitLive?.("agent/inbox/discarded", { message });
      else this.emitLive?.("agent/inbox/claimed", { message, turn });
    }
    for (const message of event.data.inserted) this.emitLive?.("agent/inbox/inserted", { message });
    return removed;
  }
}
