/**
 * logger-adapter — 引擎 Logger port → dsh/cordis 日志面的适配（阶段 2）。
 *
 * 引擎各模块只认 `@zcode/contracts` 的 `Logger`（`debug/info/warn(message, context?)`、
 * `error(message, error?, context?)`、`child(context)`，context 是结构化 LogContext）；
 * dsh 宿主的日志面是 cordis `LoggerService`（`ctx.logger(name)` 取命名 logger，方法是
 * printf 风格 `(format, ...args)`，format 无占位符时剩余参数原样拼接）。映射关系：
 *
 * - `debug/info/warn(message, context)` → `base[level](message, JSON.stringify(context))`：
 *   context 序列化成一行拼在 message 后（docker logs 单行 grep 友好）。
 * - `error(message, error?, context?)` → message + error.stack（Error 对象若直接作参数
 *   会被 cordis 的 `%o` 序列化成 `{}`，故显式取 stack 一行）+ context 序列化。
 * - `child(context)` → 闭包子 logger：每次调用的 context 与铸造时的固定 context 浅合并
 *   （`{ ...parent, ...callContext }`，由近及远覆盖，子/logger 自带字段优先级低）。
 *
 * 不做 level 过滤——cordis exporter 侧自管阈值（`LoggerService.exporter` 的 levels），
 * 适配层再过滤会让两套阈值打架。context 原样序列化（当前引擎日志不含凭证——模型 key
 * 在 dsh llm adapter 层）；若未来出现敏感字段需在此拦截。
 */
import type { Context } from "@deepseek-ai/cordis";

// @zcode/* 只经 facade 再导出（assert-facade-isolation 的红线）。
import type { LogContext, Logger } from "../engine-facade.js";

/** console 直写统一走 stderr（cordis web 模式只进内存 buffer，见 createDshLoggerAdapter）。
 *  日志走 stderr、数据走 stdout 是 Node 惯例：headless 形态（s04 smoke）以 stdout
 *  交付终答，logger 行不得混入。 */
const CONSOLE_METHOD = {
  debug: console.error,
  info: console.error,
  warn: console.error,
  error: console.error,
} as const;

/** 固定 context（child 链累积）与本次调用 context 的浅合并；两侧都缺席则维持缺席。 */
function mergeContext(
  parent: LogContext | undefined,
  context: LogContext | undefined,
): LogContext | undefined {
  return parent === undefined ? context : { ...parent, ...context };
}

/**
 * 铸造引擎 `Logger` 形状的 dsh 适配器。
 * `name` 是 cordis 命名 logger 的名字（每行日志可见），调用方给短而可 grep 的值
 * （如 `zcode-loop:<sessionId 前 8 字符>`，同一 agent 的引擎与事件桥共用一个实例）。
 */
export function createDshLoggerAdapter(ctx: Context, name: string): Logger {
  const base = ctx.logger(name);
  /** LogContext → 单行 JSON（缺席 → 空串占位，printf 拼接后只是行尾一个空格）。 */
  const serialize = (context: LogContext | undefined): string =>
    context === undefined ? "" : JSON.stringify(context);
  // 双投递：cordis ctx.logger 在 web 模式只注册内存 buffer exporter（LoggerService
  // 构造不挂 stdout），docker logs 看不到；stderr 直写一行补容器可观测面（docker
  // logs 合并两流）。若 dsh 未来接通 stdout exporter，直写行冗余可去（buffer 侧
  // 始终保留）。
  const emit = (
    level: keyof typeof CONSOLE_METHOD,
    line: string,
  ): void => {
    base[level](line);
    CONSOLE_METHOD[level](`[${name}]`, line);
  };

  const makeLogger = (parent: LogContext | undefined): Logger => ({
    debug: (message, context) => emit("debug", `${message} ${serialize(mergeContext(parent, context))}`.trimEnd()),
    info: (message, context) => emit("info", `${message} ${serialize(mergeContext(parent, context))}`.trimEnd()),
    warn: (message, context) => emit("warn", `${message} ${serialize(mergeContext(parent, context))}`.trimEnd()),
    error: (message, error, context) =>
      // stack 一行优先：无 stack 的 Error 原样透传，缺席落空串占位。
      emit(
        "error",
        `${message} ${error?.stack ?? error ?? ""} ${serialize(mergeContext(parent, context))}`.trimEnd(),
      ),
    child: (context) => makeLogger(mergeContext(parent, context)),
  });

  return makeLogger(undefined);
}
