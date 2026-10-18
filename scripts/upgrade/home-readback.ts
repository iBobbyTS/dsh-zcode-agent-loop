/**
 * 隔离演练的 home 读回门禁：只读取演练副本里的 DSH_HOME，验证 session log（v4
 * JSONL，必要时 zstd 解压）、profile/config YAML 与 storages JSON 仍可解析。
 *
 * 不写任何文件；原 home 的可变性由 drill 在复制前后做字节断言。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { installedRequire } from "../contract-verification/oracle.js";

export interface HomeReadback {
  sessions: number;
  sessionEvents: number;
  profiles: string[];
  credentials: boolean;
  storages: number;
  patches: number;
}

function yaml(): { load: (text: string) => unknown } {
  const module = installedRequire("js-yaml") as { load: (text: string) => unknown };
  return module;
}

function sessionLines(file: string): string[] {
  const content = file.endsWith(".zstd")
    ? zstdDecompressSync(readFileSync(file)).toString("utf8")
    : readFileSync(file, "utf8");
  return content.split("\n").filter((line) => line.trim() !== "");
}

export function readbackHome(home: string): HomeReadback {
  const rows: HomeReadback = {
    sessions: 0,
    sessionEvents: 0,
    profiles: [],
    credentials: false,
    storages: 0,
    patches: 0,
  };

  const sessionsRoot = join(home, "sessions");
  if (existsSync(sessionsRoot)) {
    function walkSessions(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = join(dir, entry.name);
        const log = join(child, "session.v4.jsonl.zstd");
        const plain = join(child, "session.v4.jsonl");
        const file = existsSync(log) ? log : existsSync(plain) ? plain : undefined;
        if (file === undefined) {
          walkSessions(child);
          continue;
        }
        const lines = sessionLines(file);
        for (const line of lines) {
          const event = JSON.parse(line) as { type?: unknown; seq?: unknown };
          if (typeof event.type !== "string") throw new Error(`session 事件缺少 type: ${entry.name}`);
        }
        rows.sessions += 1;
        rows.sessionEvents += lines.length;
      }
    }
    walkSessions(sessionsRoot);
  }

  const profilesRoot = join(home, "profiles");
  if (existsSync(profilesRoot)) {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(profilesRoot, entry.name);
      const packageFile = join(dir, "package.json");
      if (!existsSync(packageFile)) throw new Error(`profile 缺少 package.json: ${entry.name}`);
      const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as {
        dsh?: { profile?: { bundles?: unknown } };
      };
      if (!Array.isArray(metadata.dsh?.profile?.bundles)) {
        throw new Error(`profile 缺少 dsh.profile.bundles: ${entry.name}`);
      }
      for (const file of ["cordis.yml", "cordis.patch.yml"]) {
        const path = join(dir, file);
        if (existsSync(path)) yaml().load(readFileSync(path, "utf8"));
      }
      rows.profiles.push(entry.name);
    }
  }

  const credentials = join(home, ".credentials.yaml");
  if (existsSync(credentials)) {
    yaml().load(readFileSync(credentials, "utf8"));
    rows.credentials = true;
  }

  const storageRoot = join(home, "storages");
  if (existsSync(storageRoot)) {
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(file);
          continue;
        }
        if (entry.name.endsWith(".json")) {
          JSON.parse(readFileSync(file, "utf8"));
          rows.storages += 1;
        }
      }
    }
    walk(storageRoot);
  }

  const patchesRoot = join(home, "patches");
  if (existsSync(patchesRoot)) {
    for (const entry of readdirSync(patchesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      yaml().load(readFileSync(join(patchesRoot, entry.name), "utf8"));
      rows.patches += 1;
    }
  }

  return rows;
}

export function main(args = process.argv.slice(2)): number {
  let home: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--home" && args[index + 1] && !args[index + 1]!.startsWith("--")) home = args[++index]!;
    else throw new Error("usage: home-readback --home DIR");
  }
  if (home === undefined) throw new Error("usage: home-readback --home DIR");
  const rows = readbackHome(home);
  console.log(
    `[home-readback] sessions=${String(rows.sessions)} events=${String(rows.sessionEvents)} ` +
      `profiles=${rows.profiles.join(",") || "none"} credentials=${String(rows.credentials)} ` +
      `storages=${String(rows.storages)} patches=${String(rows.patches)}`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[home-readback] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
