/**
 * inbox — S03 的最小 next-turn inbox（ReactLoopInbox 的最小重写）。
 *
 * npm `@deepseek-ai/dsh-agent-loop` 不导出 `ReactLoopInbox`（其包导出面只有
 * AgentLoop/投影定义等），按任务合同的 fallback 走最小重写：
 *
 * - 持久性：与 stock 相同以 `agent/inbox/spliced` SessionEvent 为唯一真相
 *   （`Session.append`），本类内存态只是**自己写下的 splice 的折叠**——原型里
 *   本 agent 是该 session inbox 的唯一写者，不挂 projection registry。
 * - 语义：双 target 都按 stock splice/claim 语义实现（阶段 6 起 agent 消费
 *   next-step：busy steering 走 agent 的 steerActive append+claim；空闲 inject
 *   的 next-step 由 drain 的 `claim('next-turn')` 拼接消费——一条 followup
 *   独占一个 turn）。
 * - 事件：落盘不变；stock 的 agent/inbox/* live 词表（inserted/claimed/
 *   discarded）经构造期注入的 `emitLive` 回调补齐（阶段 6，UI 队列气泡实时
 *   显示；emit 只传实际 payload，agent 字段由 Scoped dispatch 收窄）——回调
 *   缺席时静默跳过（S03 脚本等无派发面的路径）。
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

/** inbox live 事件词表（stock 同款；emit 只传实际 payload，无 agent 字段）。 */
export type InboxLiveEvent =
  | "agent/inbox/inserted"
  | "agent/inbox/claimed"
  | "agent/inbox/discarded";

export class ZcodeLoopInbox implements Inbox {
  private state: InboxState = { "next-turn": [], "next-step": [] };

  constructor(
    private readonly session: DshSession,
    /**
     * 阶段 6：live 事件出口（agent 构造时转发进 dsh AgentEventDispatch）。
     * claimed 的 `turn` 是拥有该批的 turn 号；inserted/discarded 无 turn 语义。
     */
    private readonly emitLive?: (event: InboxLiveEvent, payload: { message: UserMessage; turn?: number }) => void,
  ) {}

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
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.apply("next-step", 0, this.state["next-step"].length, [], false, turn);
    if (target === "next-turn") {
      claimed.push(...this.apply("next-turn", 0, 1, [], false, turn));
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
    // splice 路径不产生 claimed 事件（discardRemoved=true → 全走 discarded），turn 恒 0。
    return this.apply(target, start, deleteCount, inserted, true, 0);
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ["next-turn", "next-step"] as const) {
      const index = this.state[target].findIndex((message) => message.id === messageId);
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
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount);
    for (const message of removed) {
      if (discardRemoved) this.emitLive?.("agent/inbox/discarded", { message });
      else this.emitLive?.("agent/inbox/claimed", { message, turn });
    }
    for (const message of inserted) this.emitLive?.("agent/inbox/inserted", { message });
    return removed;
  }
}
