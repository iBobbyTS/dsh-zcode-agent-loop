import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { hash, packageFile } from './oracle.js';

const core = 'vendor/zcode/apps/zcode-cli/packages/core/src';
export const manifestPath = 'scripts/contract-verification/capabilities.json';
export const dispositions = ['bridged', 'engine-default', 'dsh-alternative', 'not-integrated', 'host-incompatible', 'unknown'] as const;
export type Disposition = typeof dispositions[number];
export interface Surface { id: string; file: string; line: number; signature: string; fingerprint: string }
export interface Evidence { file: string; needle: string }
export interface CapabilityGroup {
 id: string; title: string; disposition: Exclude<Disposition, 'unknown'>; reason: string;
 evidence: Evidence[]; members: Record<string, string>;
}
export interface Manifest { schemaVersion: number; groups: CapabilityGroup[]; wiring: Record<string, string> }
const printer = ts.createPrinter({ removeComments: true });

// Inventory declarations, not a list of features inferred from the three mock scenarios.
// Inline nested configuration changes alter the signature; referenced compact/memory
// policies are inventoried separately. Internal/private methods are outside this boundary.
export function scanEngine(read: (file: string) => string = f => readFileSync(f, 'utf8')): Surface[] {
 const surfaces = new Map<string, Surface>();
 function scan(file: string, declarations: Record<string, string>) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  for (const node of source.statements) {
   if (!(ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) || !node.name) continue;
   const prefix = declarations[node.name.text]; if (!prefix) continue;
   if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.heritageClauses?.length) throw new Error(`Capability declaration now inherits members: ${file}:${node.name.text}; extend scanner explicitly`);
   const members = ts.isTypeAliasDeclaration(node)
    ? ts.isIntersectionTypeNode(node.type) ? node.type.types.flatMap(t => ts.isTypeLiteralNode(t) ? [...t.members] : []) : ts.isTypeLiteralNode(node.type) ? node.type.members : []
    : node.members;
   for (const member of members) {
    if (!member.name || ts.isConstructorDeclaration(member) || ts.getModifiers(member as ts.HasModifiers)?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword || m.kind === ts.SyntaxKind.StaticKeyword)) continue;
    if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) throw new Error(`Unsupported public name in ${file}`);
    const id = `${prefix}.${member.name.text}`;
    // The merged interface is the public signature authority for the runtime class.
    if (surfaces.has(id) && ts.isClassDeclaration(node)) continue;
    const signature = printer.printNode(ts.EmitHint.Unspecified, member, source);
    surfaces.set(id, { id, file, line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1, signature, fingerprint: hash(signature) });
   }
  }
 }
 scan(`${core}/runtime/agent-runtime.ts`, { AgentRuntime: 'api' });
 scan(`${core}/runtime/types.ts`, { AgentRuntimeConfig: 'config', AgentRuntimeDeps: 'deps', MemoryRuntimeConfig: 'memory', ExecuteTurnOptionsBase: 'turn', PromptAdmissionOptions: 'admission' });
 scan(`${core}/compact/policy.ts`, { AutoCompactPolicyConfig: 'compact' });
 const file = `${core}/tool/handlers/index.ts`, ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
 for (const node of ast.statements) if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) {
  if (decl.name.getText(ast) !== 'builtInTools' || !decl.initializer || !ts.isArrayLiteralExpression(decl.initializer)) continue;
  for (const entry of decl.initializer.elements) {
   if (!ts.isIdentifier(entry)) throw new Error('Unsupported builtInTools entry; review inventory scanner');
   const signature = entry.text, id = `tool.${signature}`;
   if (surfaces.has(id)) throw new Error(`Duplicate built-in tool: ${id}`);
   surfaces.set(id, { id, file, line: ast.getLineAndCharacterOfPosition(entry.getStart(ast)).line + 1, signature, fingerprint: hash(signature) });
  }
 }
 for (const prefix of ['api', 'config', 'deps', 'memory', 'turn', 'admission', 'compact', 'tool']) if (![...surfaces.keys()].some(k => k.startsWith(prefix + '.'))) throw new Error(`Empty capability inventory: ${prefix}`);
 return [...surfaces.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// These are the actual production assembly seams, not façade exports or test calls.
// Pin their syntax so adding/removing an entry requires updating the assessment.
export function scanWiring() {
 const rows: { id: string; file: string; line: number; fingerprint: string }[] = [];
 function scan(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
   const file = join(dir, entry.name); if (entry.isDirectory()) { scan(file); continue; }
   if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
   const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
   function record(id: string, node: ts.Node) { rows.push({ id, file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, fingerprint: hash(printer.printNode(ts.EmitHint.Unspecified, node, ast)) }); }
   function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /(?:^|\.)runtime$/.test(node.expression.expression.getText(ast))) record(`api.${node.expression.name.text}`, node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createEmbeddedEngine' && file !== 'src/engine-facade.ts') {
     record('assembly.createEmbeddedEngine', node);
    }
    ts.forEachChild(node, visit);
   }
   visit(ast);
  }
 }
 scan('src');
 return rows.sort((a, b) => `${a.id}:${a.file}:${a.fingerprint}`.localeCompare(`${b.id}:${b.file}:${b.fingerprint}`));
}
export function wiringSnapshot(rows = scanWiring()) { return Object.fromEntries(rows.map((r, i) => [`${r.file}:${r.id}:${i}`, r.fingerprint])); }

function evidence(ref: Evidence) {
 const file = ref.file.startsWith('@') ? join(dirname(packageFile(ref.file.split('/').slice(0, 2).join('/'))), ...ref.file.split('/').slice(2)) : ref.file;
 const text = readFileSync(file, 'utf8'), index = text.indexOf(ref.needle);
 if (!ref.needle || index < 0) throw new Error(`Stale capability evidence: ${ref.file} / ${ref.needle}`);
 return { ...ref, line: text.slice(0, index).split('\n').length, sha256: hash(text) };
}
export function assessCapabilities(surfaces: Surface[], manifest: Manifest, wiring = scanWiring()) {
 if (manifest.schemaVersion !== 1) throw new Error('Unsupported capability manifest');
 const assignments = new Map<string, CapabilityGroup>(), ids = new Set<string>();
 const groups = manifest.groups.map(g => {
  if (!g.id || ids.has(g.id) || !g.title || !g.reason || !g.evidence.length || !Object.keys(g.members).length || !(dispositions as readonly string[]).includes(g.disposition) || (g.disposition as string) === 'unknown') throw new Error(`Invalid capability group: ${g.id}`);
  ids.add(g.id);
  for (const key of Object.keys(g.members)) { if (assignments.has(key)) throw new Error(`Duplicate capability classification: ${key}`); assignments.set(key, g); }
  return { ...g, evidence: g.evidence.map(evidence) };
 });
 const issues: { id: string; kind: string }[] = [];
 const rows = surfaces.map(s => {
  const group = assignments.get(s.id);
  const valid = group?.members[s.id] === s.fingerprint;
  if (!valid) issues.push({ id: s.id, kind: group ? 'signature-changed' : 'unclassified' });
  return { ...s, group: group?.id ?? 'unknown', disposition: valid ? group!.disposition : 'unknown' as Disposition };
 });
 const current = new Set(surfaces.map(s => s.id));
 for (const id of assignments.keys()) if (!current.has(id)) issues.push({ id, kind: 'removed-surface' });
 const currentWiring = wiringSnapshot(wiring);
 for (const id of new Set([...Object.keys(manifest.wiring), ...Object.keys(currentWiring)])) if (manifest.wiring[id] !== currentWiring[id]) issues.push({ id, kind: 'wiring-changed' });
 const counts = Object.fromEntries(dispositions.map(d => [d, rows.filter(r => r.disposition === d).length])) as Record<Disposition, number>;
 const groupCounts = Object.fromEntries(dispositions.map(d => [d, groups.filter(g => g.disposition === d).length])) as Record<Disposition, number>;
 const openGroups = groups.filter(g => g.disposition === 'not-integrated' || g.disposition === 'host-incompatible').map(g => g.id);
 return {
  schemaVersion: 1, inventoryStatus: issues.length ? 'FAIL' : 'PASS', integrationStatus: issues.length ? 'UNKNOWN' : openGroups.length ? 'INCOMPLETE' : 'ACCOUNTED',
  scope: 'Static public AgentRuntime API, config/dependency fields, turn/admission options, memory/compact policy and builtInTools registration list. No internal-function completeness or runtime availability claim.',
  total: rows.length, counts, groupCounts, openGroups, issues, groups, rows, wiring,
 };
}
export function capabilityInventory() { return assessCapabilities(scanEngine(), JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest); }
export type CapabilityReport = ReturnType<typeof capabilityInventory>;
export const dispositionLabels: Record<Disposition, string> = { bridged: '已桥接', 'engine-default': '引擎内部默认生效', 'dsh-alternative': 'dsh 已有替代', 'not-integrated': '未接入', 'host-incompatible': '无法直接桥接（当前宿主）', unknown: '待评估' };
const html = (s: unknown) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function capabilitySection(report: CapabilityReport) {
 return `<section id="capabilities"><h2>能力入口统计：${html(report.integrationStatus)}</h2><p>源码清单检查：${html(report.inventoryStatus)}。${report.total} 个接口/字段/工具条目，${report.groups.length} 个评估分组；条目数量不是独立功能数量。</p><p>三场景差分的 0 bridge-gap 仅表示执行过的场景没有检出该类差异。全量能力仍有未接入项。dsh 已有替代仅为静态接线/插件存在证据，不保证运行可用或专属协议等价；无法直接桥接限于当前宿主契约，可通过扩展宿主改变。</p><table><tr><th>类别</th><th>条目</th><th>评估分组</th></tr>${dispositions.map(d => `<tr><td>${html(dispositionLabels[d])}</td><td>${report.counts[d]}</td><td>${report.groupCounts[d]}</td></tr>`).join('')}</table><p><a href="capabilities.html">展开全部能力、源码位置与入口证据</a> · <a href="capabilities.json">能力清单 JSON</a></p><p>机械扫描边界：${html(report.scope)}</p>${report.issues.length ? `<h3>需重新评估的变化</h3><pre>${html(JSON.stringify(report.issues, null, 2))}</pre>` : ''}<table><tr><th>能力分组</th><th>入口处置</th><th>原因与限制</th></tr>${report.groups.map(g => `<tr><td><a href="capabilities.html#${html(g.id)}">${html(g.title)}</a></td><td>${html(dispositionLabels[g.disposition])}</td><td>${html(g.reason)}</td></tr>`).join('')}</table></section>`;
}
export function capabilityMarkdown(report: CapabilityReport) {
 return ['## 能力入口统计', '', `清单检查：${report.inventoryStatus}；能力接入：${report.integrationStatus}。${report.total} 条公开接口/字段/工具，${report.groups.length} 个评估分组。`, '', '场景差分通过不代表全量能力接通；dsh 替代不代表 ZCode 专属语义等价。无法直接桥接限于当前宿主消费契约。', '', '| 类别 | 条目 | 分组 |', '| --- | ---: | ---: |', ...dispositions.map(d => `| ${dispositionLabels[d]} | ${report.counts[d]} | ${report.groupCounts[d]} |`), '', '[完整入口清单](capabilities.html) · [JSON](capabilities.json)', '', ...report.groups.map(g => `- ${g.title}：${dispositionLabels[g.disposition]}。${g.reason}`), '', `扫描边界：${report.scope}`, ''].join('\n');
}
export function writeCapabilities(report: CapabilityReport, out: string) {
 mkdirSync(resolve(out), { recursive: true });
 writeFileSync(resolve(out, 'capabilities.json'), JSON.stringify(report, null, 2) + '\n');
 writeFileSync(resolve(out, 'capabilities.md'), capabilityMarkdown(report));
 writeFileSync(resolve(out, 'capabilities.html'), `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ZCode 能力入口统计</title><style>body{font:15px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;line-height:1.6}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #cbd5e1;padding:.5rem;text-align:left;vertical-align:top}th{background:#eef2f7}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#135cb5}</style><h1>ZCode 能力入口清单</h1><a href="index.html">返回场景差分与能力总览</a>${capabilitySection(report)}<h2>逐条源码与入口依据</h2>${report.groups.map(g => `<section id="${html(g.id)}"><h3>${html(g.title)} — ${html(dispositionLabels[g.disposition])}</h3><p>${html(g.reason)}</p><details><summary>入口/替代/限制的源码依据</summary><ul>${g.evidence.map(e => `<li><code>${html(e.file)}:${e.line}</code>，定位文本 <code>${html(e.needle)}</code>，SHA256 <code>${e.sha256}</code></li>`).join('')}</ul></details><table><tr><th>接口/字段/工具</th><th>当前分类</th><th>引擎声明位置与签名</th></tr>${report.rows.filter(r => r.group === g.id).map(r => `<tr><td>${html(r.id)}</td><td>${html(dispositionLabels[r.disposition])}</td><td><code>${html(r.file)}:${r.line}</code><pre>${html(r.signature)}</pre>声明 SHA256 <code>${r.fingerprint}</code></td></tr>`).join('')}</table></section>`).join('')}<h2>实际生产接缝（仅语法定位）</h2><pre>${html(JSON.stringify(report.wiring, null, 2))}</pre></html>`);
}
export async function main(args = process.argv.slice(2)) {
 let out = '.agent-work/tmp/contract-classification/report', strict = false;
 for (let i = 0; i < args.length; i++) if (args[i] === '--strict-integration') strict = true; else if (args[i] === '--out' && args[i + 1] && !args[i + 1]!.startsWith('--')) out = args[++i]!; else throw new Error('usage: verify:capabilities [--out DIR] [--strict-integration]');
 try {
  const report = capabilityInventory(); writeCapabilities(report, out);
  console.log(`[capabilities] inventory ${report.inventoryStatus}; integration ${report.integrationStatus}; ${report.total} surfaces; ${JSON.stringify(report.counts)}; issues ${report.issues.length}`);
  for (const g of report.groups.filter(g => report.openGroups.includes(g.id))) console.log(`  ${g.disposition}: ${g.title} — ${g.reason}`);
  process.exitCode = capabilityExit(report, strict);
 } catch (error) {
  mkdirSync(resolve(out), { recursive: true });
  writeFileSync(resolve(out, 'capabilities.json'), JSON.stringify({ inventoryStatus: 'FAIL', integrationStatus: 'UNKNOWN', error: String(error) }, null, 2) + '\n');
  writeFileSync(resolve(out, 'capabilities.html'), `<!doctype html><meta charset="utf-8"><h1>Capability inventory FAIL</h1><pre>${html(String(error))}</pre>`);
  writeFileSync(resolve(out, 'capabilities.md'), `# Capability inventory FAIL\n\n${String(error)}\n`);
  console.error(`[capabilities] FAIL: ${error}`); process.exitCode = 1;
 }
}
export function capabilityExit(report: CapabilityReport, strict = false) { return report.issues.length ? 1 : strict && report.integrationStatus !== 'ACCOUNTED' ? 2 : 0; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
