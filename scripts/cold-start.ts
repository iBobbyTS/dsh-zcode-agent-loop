/**
 * S01 冷启动自证脚本：
 * 内存 SessionEventStorePort + 脚本化假 modelFactory（纯文本、无工具）构造
 * AgentRuntime，executeTurn 跑通，eventStore 收到 TurnStarted…TurnComplete 完整序列。
 *
 * 只允许 import 门面（全仓唯一 import `@zcode/*` 的文件是 src/engine-facade.ts）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionId,
  createEmbeddedEngine,
  createScriptedModelFactory,
  InMemorySessionEventStore,
  SessionEventType,
  type SessionEvent,
} from "../src/engine-facade.js";

const SCRIPTED_TEXT =
  "S01 cold start OK: the embedded ZCode AgentRuntime answered a plain-text turn.";

const EXPECTED_EVENT_SEQUENCE = [
  SessionEventType.TurnStarted,
  SessionEventType.ModelRequest,
  SessionEventType.ModelComplete,
  SessionEventType.TurnComplete,
];

function fail(message: string): never {
  console.error(`[cold-start] FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const sessionId = createSessionId("s01-cold-start");
  const eventStore = new InMemorySessionEventStore({ retention: "unbounded" });
  const workingDirectory = mkdtempSync(join(tmpdir(), "zcode-loop-cold-start-"));

  const runtime = createEmbeddedEngine({
    sessionId,
    eventStore,
    modelFactory: createScriptedModelFactory({ text: SCRIPTED_TEXT }),
    workingDirectory,
  });

  const result = await runtime.executeTurn("ping");

  if (result.response !== SCRIPTED_TEXT) {
    fail(`unexpected response text: ${JSON.stringify(result.response)}`);
  }

  const events: SessionEvent[] = await eventStore.getEvents(sessionId);
  const types = events.map((event) => event.type);
  console.log(
    `[cold-start] event sequence: ${types.map((type) => String(type)).join(" -> ")}`,
  );
  console.log(`[cold-start] response: ${result.response}`);

  if (types.length !== EXPECTED_EVENT_SEQUENCE.length) {
    fail(`expected ${EXPECTED_EVENT_SEQUENCE.length} events, got ${types.length}`);
  }
  for (let i = 0; i < EXPECTED_EVENT_SEQUENCE.length; i += 1) {
    if (types[i] !== EXPECTED_EVENT_SEQUENCE[i]) {
      fail(
        `event #${i} expected ${String(EXPECTED_EVENT_SEQUENCE[i])}, got ${String(types[i])}`,
      );
    }
  }
  if (types[0] !== SessionEventType.TurnStarted) {
    fail("sequence must start with TurnStarted");
  }
  if (types[types.length - 1] !== SessionEventType.TurnComplete) {
    fail("sequence must end with TurnComplete");
  }

  const stats = eventStore.getStats();
  console.log(`[cold-start] event store stats: ${JSON.stringify(stats)}`);
  console.log("[cold-start] PASS: TurnStarted..TurnComplete full sequence received");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
