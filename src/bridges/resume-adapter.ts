/**
 * resume-adapter — 阶段 3（提前）：resume / 冷恢复的逆向翻译件。
 *
 * 两个导出（消费方只有 src/index.ts 的 `assembleAndPublish`，source==="resume" 时）：
 *
 * - `translateDshEventsToEngineMessages`：把已 seed 进 dsh Session 的持久事件
 *   （含 `interruptedTurnClosers` 合成的 closers）逆向翻译成 ZCode 引擎
 *   `MessageWithParts[]`，经 `runtime.resumeFromStore({ persistedMessages })`
 *   灌进 messageHistory（绕开 `sessionStore.messages()`）。正向翻译表见
 *   `event-store-bridge.ts`；逆向只取 hydrator（`session-history-hydrator.ts`）
 *   实际消费的字段：
 *   - `user/message`（`source.kind === "user"` 的真用户输入）→ UserMessageInfo +
 *     TextPart（只取 text 块）；
 *   - `assistant/message` → AssistantMessageInfo + text 块 → TextPart、tool-call
 *     块 → ToolPart{status:"pending"}；
 *   - `tool/result` → 按 `data.message.toolCallId` 配对最近的 pending ToolPart，
 *     非 error → completed{output}，error → error{error}；无主结果跳过（防乱序
 *     炸会话）；
 *   - 其余事件（turn/step 骨架、request/header、其它插件的日志事件、closers 里的
 *     step/end 与 turn/end{interrupted}）一律忽略——turn/step 结构是 dsh durable
 *     format 的关系校验面，引擎历史不需要它。
 *   所有 id 用事件 seq 派生（`dsh-<seq>`），跨重启稳定且全局唯一。
 *
 * - `createResumeSessionStore`：resume 冷路径 + 后续 turn 循环用的哑
 *   `SessionStorePort`。引擎在 resume 入口强制要求 sessionStore 在场
 *   （`if (!this.sessionStore) throw`），并消费 `getSession`（directory 覆盖
 *   workingDirectory、taskType/title/revert/permission 检查）、`readTodos`/
 *   `readTarget`（有 try/catch 兜底）；messages 被 persistedMessages 直传短路。
 *   resume 成功后 `sessionPersisted=true`，turn 循环的引擎侧持久化写
 *   （saveMessage/savePart 等）一律 no-op 吞掉——dsh session log（事件桥落盘）
 *   是唯一持久化真相，引擎自持久化不重复承担。
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent as DshSessionEvent } from "@deepseek-ai/dsh-session";

import type {
  AssistantMessageInfo,
  MessageId,
  MessagePart,
  MessageWithParts,
  SessionId,
  SessionInfo,
  SessionStorePort,
  TextPart,
  ToolPart,
  UserMessageInfo,
} from "../engine-facade.js";
import { createMessageId, createPartId, createProjectId } from "../engine-facade.js";

// ------------------------------------------------------------------
// 逆向翻译
// ------------------------------------------------------------------

/** 工具入参解析容错：模型/落盘的 arguments 串损坏时退回空对象，不炸 resume。 */
function parseToolInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 解析失败 / 非对象：按空入参进历史（模型仍能看到调用与结果文本）。
  }
  return {};
}

function textBlockText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function textPart(
  engineSessionId: SessionId,
  messageId: MessageId,
  seq: number,
  partIndex: number,
  text: string,
): TextPart {
  return {
    id: createPartId(`dsh-${seq}-${partIndex}`),
    sessionID: engineSessionId,
    messageID: messageId,
    type: "text",
    text,
  };
}

/**
 * 把 dsh session 全量事件（`session.snapshotEvents(SessionLogOffset(0))`，含
 * closers）逆向翻译成引擎历史。顺序即事件序；mid-log 的 plugin 记录等未知
 * 事件类型按 default 忽略。
 */
export function translateDshEventsToEngineMessages(
  events: readonly DshSessionEvent[],
  engineSessionId: SessionId,
): MessageWithParts[] {
  const messages: MessageWithParts[] = [];
  /** callID → 最近一个铸造出来的 pending ToolPart（tool/result 配对用）。 */
  const openToolParts = new Map<string, ToolPart>();
  /** 最近一条 user 消息 id（assistant 的 parentID 消费用）。 */
  let lastUserId: MessageId | undefined;

  for (const event of events) {
    // id 用事件 seq 派生：跨重启稳定、log 内唯一（每个消息类事件只产一条消息）。
    const messageId = createMessageId(`dsh-${event.seq}`);
    switch (event.type) {
      case "user/message": {
        // dsh SessionEventMap：user/message 的 data 就是 UserMessage 本体。
        const message = event.data;
        // 只收真用户输入；合成 inject（file-change 通知等）的 source.kind 不同，
        // 逆向不进引擎历史（plan 改动清单第 1 条）。
        if (message.source.kind !== "user") break;
        const info: UserMessageInfo = {
          id: messageId,
          sessionID: engineSessionId,
          role: "user",
          time: { created: event.time },
          agent: "main",
        };
        const parts: MessagePart[] = [];
        let partIndex = 0;
        for (const block of message.content) {
          if (block.type === "text") {
            parts.push(textPart(engineSessionId, messageId, event.seq, partIndex, block.text));
          }
          partIndex += 1;
        }
        messages.push({ info, parts });
        lastUserId = messageId;
        break;
      }
      case "assistant/message": {
        const info: AssistantMessageInfo = {
          id: messageId,
          sessionID: engineSessionId,
          role: "assistant",
          time: { created: event.time },
          // parentID 必填：正常 log 里 assistant 之前必有 user；防御性回落自身。
          parentID: lastUserId ?? messageId,
          mode: "default",
          agent: "main",
          // path/cost/tokens 是契约必填但 hydrator 不消费：历史恢复的合成时间线
          // 给中性值（tokens 全零 → 空 assistant 被 hydrate 自然跳过）。
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        const parts: MessagePart[] = [];
        let partIndex = 0;
        for (const block of event.data.message.content) {
          if (block.type === "text") {
            parts.push(textPart(engineSessionId, messageId, event.seq, partIndex, block.text));
          } else if (block.type === "tool-call") {
            const part: ToolPart = {
              id: createPartId(`dsh-${event.seq}-${partIndex}`),
              sessionID: engineSessionId,
              messageID: messageId,
              type: "tool",
              callID: block.id,
              tool: block.name,
              // 先铸 pending；随后的 tool/result 就地结算成 completed/error。
              // 无 result 的调用保持 pending —— hydrator 按中断语义占位
              // （"[Tool execution was interrupted before resume]"）。
              state: {
                status: "pending",
                input: parseToolInput(block.arguments),
                raw: block.arguments,
              },
            };
            parts.push(part);
            openToolParts.set(block.id, part);
          }
          partIndex += 1;
        }
        messages.push({ info, parts });
        break;
      }
      case "tool/result": {
        // ToolResultMessage.toolCallId 是 provider 配对字段（bridge 写入侧经
        // createToolResultMessage({callId}) 也落在它上）。
        const message = event.data.message;
        const part = openToolParts.get(message.toolCallId);
        // 无主结果（乱序/重复/历史脏数据）：跳过，防炸会话。
        if (part === undefined) break;
        const text = textBlockText(message.content);
        if (message.isError === true || event.data.error !== undefined) {
          part.state = {
            status: "error",
            input: part.state.input,
            error: text,
            time: { start: event.time, end: event.time },
          };
        } else {
          part.state = {
            status: "completed",
            input: part.state.input,
            output: text,
            title: part.tool,
            metadata: {},
            time: { start: event.time, end: event.time },
          };
        }
        openToolParts.delete(message.toolCallId);
        break;
      }
      default:
        // turn/step 骨架、request/header、session 生命周期与其它插件事件不进引擎历史。
        break;
    }
  }
  return messages;
}

// ------------------------------------------------------------------
// 哑 SessionStorePort（resumeFromStore 冷路径专用）
// ------------------------------------------------------------------

/**
 * 铸 resume 冷路径专用的哑 `SessionStorePort`。`sessionInfo` 由
 * {@link createResumeSessionInfo} 按 contracts 最小必填装配（directory=会话
 * cwd——引擎会用它覆盖 `workingDirectory`；revert/permission 缺省走无 rewind/
 * 无 mode 覆盖分支）。
 */
export function createResumeSessionStore(
  engineSessionId: SessionId,
  sessionInfo: SessionInfo,
): SessionStorePort {
  return {
    // resume 入口校验 + directory/taskType/title/revert/permission 消费都走这里。
    getSession: (sessionID: SessionId) =>
      Promise.resolve(sessionID === engineSessionId ? sessionInfo : null),
    // persistedMessages 直传短路了本方法；保底返回空（引擎按零历史 warn 后继续）。
    messages: () => Promise.resolve([]),
    // todo/goal 上下文读取有 try/catch 兜底：返回空即「无 todo/goal 可恢复」。
    readTodos: () => Promise.resolve([]),
    readTarget: () => Promise.resolve(null),
    // resumeFromStore 置 sessionPersisted=true 后，turn 循环会对每条消息调
    // saveMessage/savePart（引擎自己的持久化通路）。真持久化由 dsh session log
    // （事件桥落盘）承担，这里一律吞掉写副作用，避免哑 store 在热路径 TypeError
    // （实测：resume 后首轮即调 saveMessage）。
    saveMessage: () => Promise.resolve(),
    savePart: () => Promise.resolve(),
    removeMessage: () => Promise.resolve(),
    removePart: () => Promise.resolve(),
    saveSessionEntry: () => Promise.resolve(),
    updateTodos: () => Promise.resolve(),
    // 生命周期/事务方法在未接子系统（fork/compact/target/输入账本）不会被走到；
    // no-op 返回形状安全值，防未来接入时的哑弹。
    createSession: () => Promise.resolve(structuredClone(sessionInfo)),
    updateSession: () => Promise.resolve(structuredClone(sessionInfo)),
    listSessions: () => Promise.resolve([]),
    sessionEntries: () => Promise.resolve([]),
    listSessionInputs: () => Promise.resolve([]),
    getSessionInputById: () => Promise.resolve(null),
    saveSessionInput: () => Promise.resolve(),
    updateSessionInputs: () => Promise.resolve(),
    promoteSessionInput: () => Promise.resolve(true),
    markSessionInputPromoted: () => Promise.resolve(),
    settleSessionInput: () => Promise.resolve(),
    commitPermissionFullAccess: () => Promise.resolve(true),
    setTarget: () => Promise.resolve(),
    createTarget: () => Promise.resolve(),
    updateTargetStatus: () => Promise.resolve(),
    startTargetRun: () => Promise.resolve(),
    heartbeatTargetRun: () => Promise.resolve(),
    finishTargetRun: () => Promise.resolve(),
    updateTargetSummaryTitle: () => Promise.resolve(),
    accountTargetUsage: () => Promise.resolve(),
  } as unknown as SessionStorePort;
}

/**
 * resume 冷路径 `SessionInfo` 装配（contracts 必填字段集中在此对齐）：
 * title="" 让引擎标题同步短路；time.created 用 dsh 存储 header 时间；
 * projectID/slug/version 是契约必填但 resumeFromStore 不消费，给稳定中性值。
 */
export function createResumeSessionInfo(
  engineSessionId: SessionId,
  directory: string,
  timeCreated: number,
): SessionInfo {
  return {
    id: engineSessionId,
    projectID: createProjectId("zcode-loop-resume"),
    taskType: "interactive",
    slug: "",
    directory,
    title: "",
    version: "0.0.0",
    time: { created: timeCreated, updated: timeCreated },
  };
}
