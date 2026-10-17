/**
 * 低峰调度命令：把本地时段策略映射到 dsh schedule 的持久条目。
 *
 * 语义边界（最小诚实）：
 * - 策略只是本地时窗（HH:MM-HH:MM，结束分钟含整分钟），不做云端优惠/计费承诺。
 * - 创建时的“触发”就是当前时刻：落在窗口内 → 数秒后投递；落在窗口外 →
 *   重排到下一个窗口开启，窗口外不投递。dsh schedule 没有投递前钩子，所以
 *   重排发生在写条目之前，条目落盘的目标时刻始终在窗口内。
 * - 条目是一-shot（`at`）：dsh 的存储/重启恢复/原 Session 投递全部复用；
 *   窗口策略随标题前缀持久化，list/cancel 据此识别本插件的条目。
 * - 计划时刻用本地时区计算；dsh `at` 只存 UTC instant（源码语义），本地窗口
 *   信息留在标题前缀里，不额外伪造字段。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import type { ScheduleRecord } from "@deepseek-ai/dsh-schedule";

/** 本地时窗；start/end 为当日分钟数，end 含整分钟。start > end 表示跨午夜。 */
export interface OffPeakWindow {
  readonly startMinute: number;
  readonly endMinute: number;
  /** 规范化的 `HH:MM-HH:MM`。 */
  readonly label: string;
}

/** 条目标题前缀：`offpeak [HH:MM-HH:MM] <message>`（message 按 120 字符截断）。 */
const TITLE_PREFIX = "offpeak";
const TITLE_PATTERN = /^offpeak \[(\d{2}:\d{2})-(\d{2}:\d{2})\] /;
const MAX_TITLE_LENGTH = 120;

function parseClock(text: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function formatClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** 解析 `HH:MM-HH:MM`；非法边界（24:00、60 分、不等长）返回 undefined。 */
export function parseOffPeakWindow(text: string): OffPeakWindow | undefined {
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(text.trim());
  if (match === null) return undefined;
  const startMinute = parseClock(match[1]!);
  const endMinute = parseClock(match[2]!);
  if (startMinute === undefined || endMinute === undefined || startMinute === endMinute) return undefined;
  return {
    startMinute,
    endMinute,
    label: `${formatClock(startMinute)}-${formatClock(endMinute)}`,
  };
}

/** 当前本地时刻是否在窗口内（end 分钟整段算在内；跨午夜窗口取两侧并集）。 */
export function isWithinOffPeakWindow(now: Date, window: OffPeakWindow): boolean {
  const minute = now.getHours() * 60 + now.getMinutes();
  if (window.startMinute < window.endMinute) {
    return minute >= window.startMinute && minute <= window.endMinute;
  }
  return minute >= window.startMinute || minute <= window.endMinute;
}

function atLocalClock(now: Date, minute: number, dayOffset: number): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    Math.floor(minute / 60),
    minute % 60,
    0,
    0,
  );
}

/** 下一个窗口开启（严格晚于 now；本地时区，不受当前是否在窗口内影响）。 */
export function nextOffPeakOpen(now: Date, window: OffPeakWindow): Date {
  const today = atLocalClock(now, window.startMinute, 0);
  return today.getTime() > now.getTime() ? today : atLocalClock(now, window.startMinute, 1);
}

/**
 * 把一次“现在触发”的请求折算成实际投递时刻：
 * 窗口内 → now + 1s（dsh `at` 要求严格未来；若这一秒跨出窗口则重排）；
 * 窗口外 → 下一个窗口开启。结果总在窗口内，窗口外不会投递。
 */
export function resolveOffPeakTarget(now: Date, window: OffPeakWindow): Date {
  if (!isWithinOffPeakWindow(now, window)) return nextOffPeakOpen(now, window);
  const candidate = new Date(now.getTime() + 2_000);
  return isWithinOffPeakWindow(candidate, window) ? candidate : nextOffPeakOpen(candidate, window);
}

/** 从标题前缀恢复窗口（list/cancel 只认本插件创建的条目）。 */
export function parseOffPeakTitle(title: string): OffPeakWindow | undefined {
  const match = TITLE_PATTERN.exec(title);
  return match === null ? undefined : parseOffPeakWindow(`${match[1]}-${match[2]}`);
}

function offPeakTitle(window: OffPeakWindow, message: string): string {
  const prefix = `${TITLE_PREFIX} [${window.label}] `;
  const available = MAX_TITLE_LENGTH - prefix.length;
  const title = `${prefix}${message.length > available ? message.slice(0, available) : message}`.trimEnd();
  return title;
}

function isOffPeakRecord(record: ScheduleRecord): boolean {
  return parseOffPeakTitle(record.title) !== undefined;
}

function describeWindow(window: OffPeakWindow): string {
  return window.startMinute < window.endMinute
    ? `${window.label} local`
    : `${window.label} local (crosses midnight)`;
}

function describeRecord(record: ScheduleRecord): string {
  const window = parseOffPeakTitle(record.title);
  const next = new Date(record.scheduledAt);
  return `${record.id} [${window?.label ?? "off-peak"}] next ${next.toLocaleString()} (${record.scheduledAt}) — ${record.prompt}`;
}

/** 注册 `/offpeak create|list|cancel`；仅在 schedule + commands 都在场时调用。 */
export function registerOffPeakCommands(ctx: Context): void {
  ctx.commands.register({
    name: "offpeak",
    description: "Schedule a reminder inside a local off-peak time window",
    input: { hint: "create <HH:MM-HH:MM> <message> | list | cancel <id>" },
    handler: async ({ agent, rawInput, signal }) => {
      signal.throwIfAborted();
      const input = rawInput.trim();
      const [action, ...rest] = input.split(/\s+/);
      try {
        if (action === "create") {
          const match = /^create\s+(\d{2}:\d{2}-\d{2}:\d{2})\s+([\s\S]+)$/.exec(input);
          const window = match === null ? undefined : parseOffPeakWindow(match[1]!);
          const message = match?.[2]?.trim() ?? "";
          if (window === undefined || message.length === 0) {
            return { kind: "error", text: "Usage: /offpeak create <HH:MM-HH:MM> <message>" };
          }
          const now = new Date();
          const target = resolveOffPeakTarget(now, window);
          const record = await ctx.schedule.create(agent.id, {
            title: offPeakTitle(window, message),
            prompt: message,
            at: target.toISOString(),
          }, signal);
          const rescheduled = !isWithinOffPeakWindow(now, window);
          return {
            kind: "success",
            text: `Off-peak reminder ${record.id} scheduled for ${target.toLocaleString()} (${record.scheduledAt}) in ${describeWindow(window)}${
              rescheduled ? "; the current time was outside the window and the trigger was moved to the next opening" : ""
            }.`,
          };
        }
        if (action === "list") {
          const records = (await ctx.schedule.list({ sessionId: agent.id })).filter(isOffPeakRecord);
          return {
            kind: "success",
            text: records.length === 0 ? "No off-peak reminders." : records.map(describeRecord).join("\n"),
          };
        }
        if (action === "cancel") {
          const id = rest[0];
          if (id === undefined || rest.length > 1) {
            return { kind: "error", text: "Usage: /offpeak cancel <id>" };
          }
          const records = await ctx.schedule.list({ sessionId: agent.id });
          const record = records.find((candidate) => candidate.id === id);
          if (record === undefined || !isOffPeakRecord(record)) {
            return { kind: "error", text: `No off-peak reminder "${id}" in this session.` };
          }
          const result = await ctx.schedule.delete({ sessionId: agent.id, id: record.id }, signal);
          return result.deleted
            ? { kind: "success", text: `Off-peak reminder ${record.id} cancelled.` }
            : { kind: "error", text: `Off-peak reminder "${id}" no longer exists.` };
        }
        return { kind: "error", text: "Usage: /offpeak create <HH:MM-HH:MM> <message> | list | cancel <id>" };
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
