#!/usr/bin/env node
// dsh-web-preview prepare：把 zcode-loop 插件装进开发 DSH_HOME，并备好启动用的
// patch 层。幂等可重跑；每次刷新插件 bundle 与 patch 文件，不动你的用户层与凭证。
//
// 用法：node .agents/skills/dsh-web-preview/scripts/prepare.mjs [DSH_HOME]
//   DSH_HOME 缺省 <repo>/.agent-work/dsh-home —— 跨次复用的开发 home，
//   模型 key 由你在里面配置（web UI 的 Models 页 / .credentials.yaml / .env）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DIST_ENTRY = join(REPO_ROOT, "dist", "src", "index.js");
const REPO_PATCH = join(REPO_ROOT, "cordis.patch.yml");
const home = resolve(process.argv[2] ?? join(REPO_ROOT, ".agent-work", "dsh-home"));
const bundleDir = join(REPO_ROOT, ".agent-work", "tmp", "web-preview", "bundle");

if (!existsSync(join(REPO_ROOT, "package.json")) ||
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name !== "dsh-plugin-zcode-loop") {
  console.error("[prepare] REPO_ROOT 定位失败（期望 dsh-plugin-zcode-loop）：" + REPO_ROOT);
  process.exit(1);
}
if (!existsSync(DIST_ENTRY)) {
  console.error("[prepare] dist/src/index.js 不存在 —— 先在仓库根跑 `pnpm build`");
  process.exit(1);
}

// ---- 1. esbuild 单文件 bundle（@deepseek-ai/* external，运行时由 dsh 宿主供给）----
const require = createRequire(join(REPO_ROOT, "package.json"));
const esbuild = require("esbuild");
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
esbuild.buildSync({
  entryPoints: [{ in: DIST_ENTRY, out: "index" }],
  outdir: bundleDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  logLevel: "warning",
  // CJS 传递依赖（@zcode/core 的 yaml/typescript 等）在 ESM 输出里需要 require 探测。
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __fileURLToPath(new URL('./', import.meta.url));",
    ].join("\n"),
  },
  external: [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-agent",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-system-prompt",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/schemastery",
  ],
});

// ---- 2. web profile（镜像 dsh shipped `web` 模板；已存在不覆盖用户层）----
const profileDir = join(home, "profiles", "web");
mkdirSync(profileDir, { recursive: true });
const manifestPath = join(profileDir, "package.json");
if (!existsSync(manifestPath)) {
  writeFileSync(manifestPath, JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  }, null, 2) + "\n");
}
const profilePatchPath = join(profileDir, "cordis.patch.yml");
if (!existsSync(profilePatchPath)) {
  writeFileSync(profilePatchPath, "# profile 用户层（本文件由你维护，prepare 不覆盖）\n[]\n");
}
const workspaceYamlPath = join(profileDir, "pnpm-workspace.yaml");
if (!existsSync(workspaceYamlPath)) {
  writeFileSync(workspaceYamlPath, "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
}

// ---- 3. 插件包物化（每次刷新，保证与当前构建一致）----
const pkgDir = join(profileDir, "node_modules", "dsh-plugin-zcode-loop");
rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });
cpSync(join(bundleDir, "index.js"), join(pkgDir, "index.js"));
writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
  name: "dsh-plugin-zcode-loop",
  version: "0.0.0",
  private: true,
  type: "module",
  exports: { ".": "./index.js" },
}, null, 2) + "\n");

// ---- 4. 启动 patch 层（挂在 DSH_HOME 下，容器只挂这一个卷）----
mkdirSync(join(home, "patches"), { recursive: true });
mkdirSync(join(home, "workspace"), { recursive: true });
// 默认工作区根：容器内 /data/documents（= 本目录 documents/）。首启时 web UI 会
// 请求创建默认工作区；容器是 slim 镜像没有 xdg-user-dir，解析系统 Documents 目录
// 必败，所以必须显式配置 workspace-controller 的 documentsDirectory（否则弹
// “Unable to create default workspace”）。registry 会自己 mkdir -p。
mkdirSync(join(home, "documents"), { recursive: true });
cpSync(REPO_PATCH, join(home, "patches", "repo.patch.yml"));
writeFileSync(join(home, "patches", "web-overlay.yml"), [
  "# web 预览 overlay（prepare.mjs 每次刷新）：把 zcode-loop 行对齐 profile 的",
  "# stock 默认路由。不预配任何凭证 —— 模型 key 由你在本 home 里配置：",
  "# web UI 的 Models 页（写入 .credentials.yaml）、或 $DSH_HOME/.env 的",
  "# DEEPSEEK_API_KEY=...（详见 dsh credentials-local 的优先级说明）。",
  "- id: zcode-loop",
  "  config:",
  "    provider: deepseek-official",
  "    model: deepseek-flash",
  "",
  "# 容器里没有 xdg-user-dir，系统 Documents 目录解析不出来；显式指定首启默认",
  "# 工作区根目录（容器内路径 /data/documents），否则首次打开页面会弹",
  "# “Unable to create default workspace”。最终目录：",
  "# /data/documents/deepseek-harness/default-workspace。",
  "- id: workspace-controller",
  "  config:",
  "    documentsDirectory: /data/documents",
  "",
].join("\n"));

console.log(`[prepare] DSH_HOME=${home}`);
console.log(`[prepare] 插件已物化：${join(pkgDir, "index.js")}`);
console.log(`[prepare] patch 层：${join(home, "patches", "{repo.patch.yml,web-overlay.yml}")}`);
