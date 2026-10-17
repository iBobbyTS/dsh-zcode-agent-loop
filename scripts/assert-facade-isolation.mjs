#!/usr/bin/env node
// 门面隔离断言：门面外无任何文件 import `@zcode/*`。
// 扫描本仓库自己的源码（排除 vendor/、reference/、node_modules/、dist/、.git/、.agent-work/），
// 命中 import 语句里出现 `@zcode/` 的文件只允许是 src/engine-facade.ts。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FACADE = "src/engine-facade.ts";
const SKIP_DIRS = new Set([
  "vendor",
  "reference",
  "node_modules",
  "dist",
  ".git",
  ".agent-work",
  ".vscode",
]);
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
// import 语句形态的 `@zcode/` 引用（静态、动态、export-from）。
const IMPORT_PATTERN = /(from\s*|import\s*\(\s*|require\s*\(\s*)["']@zcode\//;

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full);
      continue;
    }
    if (!CODE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) continue;
    const relative = full.slice(repoRoot.length + 1);
    const text = readFileSync(full, "utf8");
    if (IMPORT_PATTERN.test(text) && relative !== FACADE) {
      offenders.push(relative);
    }
  }
}

walk(repoRoot);

if (offenders.length > 0) {
  console.error("[verify:facade] FAIL: files importing @zcode/* outside the facade:");
  for (const file of offenders) console.error(`  - ${file}`);
  process.exit(1);
}
console.log(`[verify:facade] PASS: only ${FACADE} imports @zcode/*`);
