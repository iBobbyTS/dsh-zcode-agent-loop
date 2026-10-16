/**
 * inbox — S03 的最小 next-turn inbox（ReactLoopInbox 的最小重写）。
 *
 * npm `@deepseek-ai/dsh-agent-loop` 不导出 `ReactLoopInbox`（其包导出面只有
 * AgentLoop/投影定义等），按任务合同的 fallback 走最小重写：
 *
 * - 持久性：与 stock 相同以 `agent/inbox/spliced` SessionEvent 为唯一真相
 *   （`Session.append`），本类内存态只是**自己写下的 splice 的折叠**——原型里
 *   本 agent 是该 session inbox 的唯一写者，不挂 projection registry。
 * - 语义裁剪（v0）：只实现 next-turn 语义。`next-step` 列表保持存在（接口
 *   要求）但外壳不消费它；`claim('next-turn')` 取 next-step 批 + 一条
 *   next-turn 消息（与 stock 对齐：一条 followup 独占一个 turn）。
 * - 事件：不重发 stock 的 agent/inbox/* live 事件（那是 AgentEventDispatch 的
 *   面，外壳只在 agent/status 与 agent/error 上发声）——原型裁剪，落盘事件
 *   完整保留。
 */
import type { ContentBlock, MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Inbox, InboxState, InboxTarget } from "@deepseek-ai/dsh-agent";
import type { Session as DshSession } from "@deepseek-ai/dsh-session";

/** 消息文本投影（引擎 turn 输入是纯文本；非 text 块占位）。 */
export function userMessageText(message: UserMessage): string {
  const content: readonly ContentBlock[] = message.content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
    .join("\n");
}

export class ZcodeLoopInbox implements Inbox {
  private state: InboxState = { "next-turn": [], "next-step": [] };

  constructor(private readonly session: DshSession) {}

  get nextTurn(): readonly UserMessage[] {
    return this.state["next-turn"];
  }

  get nextStep(): readonly UserMessage[] {
    return this.state["next-step"];
  }

  get hasPending(): boolean {
    return this.state["next-turn"].length > 0 || this.state["next-step"].length > 0;
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
  claim(target: InboxTarget, _turn: number): UserMessage[] {
    const claimed = this.apply("next-step", 0, this.state["next-step"].length, [], false);
    if (target === "next-turn") {
      claimed.push(...this.apply("next-turn", 0, 1, [], false));
    }
    return claimed;
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message]);
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
    return this.apply(target, start, deleteCount, inserted, true);
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ["next-turn", "next-step"] as const) {
      const index = this.state[target].findIndex((message) => message.id === messageId);
      if (index >= 0) return { target, index };
    }
    return undefined;
  }

  /** 归一化 splice → 内存折叠 + `agent/inbox/spliced` 落盘（唯一真相）。 */
  private apply(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.state[target];
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
    if (actualDeleteCount === 0 && inserted.length === 0) return [];
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted);
    const ids = new Set<string>();
    for (const message of target === "next-turn"
      ? [...candidate, ...this.state["next-step"]]
      : [...this.state["next-turn"], ...candidate]) {
      if (ids.has(message.id)) {
        throw new Error(`message "${message.id}" is already pending`);
      }
      ids.add(message.id);
    }
    this.state =
      target === "next-turn"
        ? { "next-turn": candidate, "next-step": this.state["next-step"] }
        : { "next-turn": this.state["next-turn"], "next-step": candidate };
    const outcome = discardRemoved && actualDeleteCount > 0 ? ("canceled" as const) : undefined;
    this.session.append("agent/inbox/spliced", {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    });
    return inbox.slice(actualStart, actualStart + actualDeleteCount);
  }
}
