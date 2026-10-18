/**
 * 验收族总表：消费显式登记表与当前 twin 矩阵，分别展示执行结果、验收族事实
 * 和任务状态。退出语义：未知差异/执行失败/登记失配 → 1；已知 open 与缺环境
 * 未验收 → 0。覆盖数量不推导"全部接入"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, type Input } from './classifier.js';
import { capabilityInventory, type CapabilityReport } from './capabilities.js';
import { runMatrix, scenarios } from './runner.js';
import {
 acceptanceBoundaries,
 acceptanceFamilies,
 requiredFamilies,
 taskRecords,
 type AcceptanceItem,
 type EvidenceRef,
} from './acceptance-registry.js';

const h = (s: unknown) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const commandText = (ref: EvidenceRef) => ref.kind === 'command' ? `pnpm ${ref.ref}` : ref.ref;
const taskRecordsById = new Map(taskRecords.map(t => [t.id, t]));

interface FamilySummary { id: string; title: string; counts: Record<'covered' | 'open' | 'unverified', number>; items: AcceptanceItem[] }
interface RegistryIssue { kind: string; id: string; detail: string }

function validateRegistry(): RegistryIssue[] {
 const issues: RegistryIssue[] = [];
 const scripts = new Set(Object.keys((JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts));
 if (acceptanceFamilies.length !== requiredFamilies.length) issues.push({ kind: 'family-count', id: 'families', detail: `expected ${requiredFamilies.length}, got ${acceptanceFamilies.length}` });
 for (const [index, required] of requiredFamilies.entries()) {
  const family = acceptanceFamilies[index];
  if (!family || family.id !== required.id || family.title !== required.title) issues.push({ kind: 'family-order', id: required.id, detail: `position ${index} must be ${required.id}/${required.title}` });
 }
 const familyIds = new Set<string>();
 const itemIds = new Set<string>();
 const checkEvidence = (owner: string, refs: EvidenceRef[]) => {
  for (const ref of refs) {
   if (ref.kind === 'command' && !scripts.has(ref.ref)) issues.push({ kind: 'missing-command', id: owner, detail: ref.ref });
   else if (ref.kind === 'browser' && !existsSync(resolve(ref.ref))) issues.push({ kind: 'missing-browser-evidence', id: owner, detail: ref.ref });
   else if (ref.kind === 'scenario' && !scenarios.includes(ref.ref as typeof scenarios[number])) issues.push({ kind: 'unknown-scenario', id: owner, detail: ref.ref });
  }
 };
 for (const family of acceptanceFamilies) {
  if (familyIds.has(family.id)) issues.push({ kind: 'duplicate-family', id: family.id, detail: family.id }); familyIds.add(family.id);
  if (!family.items.length) issues.push({ kind: 'empty-family', id: family.id, detail: 'family has no result' });
  for (const item of family.items) {
   if (itemIds.has(item.id)) issues.push({ kind: 'duplicate-item', id: item.id, detail: item.id }); itemIds.add(item.id);
   if (!['covered', 'open', 'unverified'].includes(item.status)) issues.push({ kind: 'status', id: item.id, detail: item.status });
   if (item.status !== 'covered' && !item.reason) issues.push({ kind: 'missing-reason', id: item.id, detail: item.status });
   if (item.status === 'covered' && !item.evidence.length) issues.push({ kind: 'missing-evidence', id: item.id, detail: 'covered without evidence' });
   if (!taskRecordsById.has(item.task)) issues.push({ kind: 'unknown-task', id: item.id, detail: item.task });
   checkEvidence(item.id, item.evidence);
  }
 }
 const taskIds = new Set<string>();
 for (const task of taskRecords) {
  if (taskIds.has(task.id)) issues.push({ kind: 'duplicate-task', id: task.id, detail: task.id }); taskIds.add(task.id);
  if (!['accepted', 'partial', 'open'].includes(task.status)) issues.push({ kind: 'task-status', id: task.id, detail: task.status });
  if (task.status !== 'accepted' && !(task.remaining?.length)) issues.push({ kind: 'missing-remaining', id: task.id, detail: task.status });
  checkEvidence(task.id, task.evidence);
 }
 for (let n = 1; n <= 24; n++) { const id = `T${String(n).padStart(2, '0')}`; if (!taskIds.has(id)) issues.push({ kind: 'missing-task', id, detail: id }); }
 return issues;
}

function classifyMatrix(matrix: Awaited<ReturnType<typeof runMatrix>>) {
 const errors = matrix.results.filter(r => Object.keys(r.errors ?? {}).length).map(r => r.scenario);
 if (matrix.results.length !== scenarios.length || new Set(matrix.results.map(r => r.scenario)).size !== scenarios.length) throw new Error('matrix did not execute every registered scenario exactly once');
 if (errors.length) throw new Error(`matrix capture failed: ${errors.join(', ')}`);
 const classified = classify(matrix as unknown as Input);
 const executed = matrix.results.map(r => ({ scenario: r.scenario, differences: r.differences.length, rawStatus: r.status }));
 return { classified, executed };
}

function renderMarkdown(report: Awaited<ReturnType<typeof buildReport>>) {
 const lines = [
  '# 验收与状态总表', '',
  `**${report.status}**（退出 ${report.exitCode}）。这不是完整接入声明：${report.completeness}`, '',
  `- twin 矩阵：${report.matrix.executed.length}/${scenarios.length} 场景执行；原始差异 ${report.matrix.counts.raw}（intentional ${report.matrix.counts.intentional} / noise ${report.matrix.counts.noise} / bridge-gap ${report.matrix.counts['bridge-gap']} / unknown ${report.matrix.counts.unknown}）。unknown 差分${report.matrix.unknown ? '存在，门禁失败' : '为 0'}。`,
  `- 语义差异：bridge-gap ${report.matrix.semanticIssueCounts['bridge-gap']}，unknown ${report.matrix.semanticIssueCounts.unknown}。`,
  `- 登记表：${report.registry.familyCounts.total} 族（全部项 covered ${report.registry.familyCounts.fullyCovered} / 含 open ${report.registry.familyCounts.withOpen} / 含 unverified ${report.registry.familyCounts.withUnverified}）；任务 accepted ${report.registry.taskCounts.accepted} / partial ${report.registry.taskCounts.partial} / open ${report.registry.taskCounts.open}。`,
  `- 能力清单（独立状态，不是验收结果）：inventory ${report.capabilities.inventoryStatus}；integration ${report.capabilities.integrationStatus}。`, '',
  '## 验收族', '',
 ];
 for (const family of report.registry.families as FamilySummary[]) {
  lines.push(`### ${family.title}`, '', `covered ${family.counts.covered} / open ${family.counts.open} / unverified ${family.counts.unverified}`, '', '| 要求 | 状态 | 证据 | 说明 |', '| --- | --- | --- | --- |');
  for (const item of family.items) lines.push(`| ${item.requirement} | ${item.status} | ${item.evidence.map(e => `\`${commandText(e)}\``).join('、') || '—'} | ${item.reason ?? ''} |`);
  lines.push('');
 }
 lines.push('## 任务状态', '', '| 任务 | 状态 | 证据 | 剩余 |', '| --- | --- | --- | --- |');
 for (const task of taskRecords) lines.push(`| ${task.id} ${task.title} | ${task.status} | ${task.evidence.map(e => `\`${commandText(e)}\``).join('、') || '—'} | ${task.remaining?.join('；') ?? ''} |`);
 lines.push('', '## 矩阵执行', '', '| 场景 | 原始差异 | 原始状态 |', '| --- | ---: | --- |');
 for (const scenario of report.matrix.executed) lines.push(`| ${scenario.scenario} | ${scenario.differences} | ${scenario.rawStatus} |`);
 lines.push('', '原始矩阵状态为 FAIL 表示存在未列入 allowances 的原始差异；分类结果才是验收事实。', '', '## 边界', '', ...acceptanceBoundaries.map(b => `- ${b}`));
 if (report.issues.length) lines.push('', '## 登记失配', '', ...report.issues.map(i => `- ${i.kind}: ${i.id} — ${i.detail}`));
 return lines.join('\n') + '\n';
}

function renderHtml(report: Awaited<ReturnType<typeof buildReport>>) {
 const families = (report.registry.families as FamilySummary[]).map(family => `<section><h2>${h(family.title)}</h2><p>covered ${family.counts.covered} / open ${family.counts.open} / unverified ${family.counts.unverified}</p><table><tr><th>要求</th><th>状态</th><th>证据</th><th>说明</th></tr>${family.items.map(item => `<tr><td>${h(item.requirement)}</td><td class="${h(item.status)}">${h(item.status)}</td><td>${item.evidence.map(e => `<code>${h(commandText(e))}</code>`).join('<br>') || '—'}</td><td>${h(item.reason ?? '')}</td></tr>`).join('')}</table></section>`).join('');
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>验收与状态总表</title><style>body{font:15px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;line-height:1.6}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #cbd5e1;padding:.5rem;text-align:left;vertical-align:top}th{background:#eef2f7}code{overflow-wrap:anywhere}.covered{color:#166534}.open{color:#9a3412}.unverified{color:#6b7280}pre{white-space:pre-wrap}</style><h1>验收与状态总表</h1><p><strong>${h(report.status)}</strong>（退出 ${report.exitCode}）。这不是完整接入声明：${h(report.completeness)}</p><ul><li>twin 矩阵：${report.matrix.executed.length}/${scenarios.length} 场景；原始差异 ${report.matrix.counts.raw}；unknown ${report.matrix.counts.unknown}</li><li>登记表：${report.registry.familyCounts.total} 族（全部项 covered ${report.registry.familyCounts.fullyCovered} / 含 open ${report.registry.familyCounts.withOpen} / 含 unverified ${report.registry.familyCounts.withUnverified}）</li><li>任务：accepted ${report.registry.taskCounts.accepted} / partial ${report.registry.taskCounts.partial} / open ${report.registry.taskCounts.open}</li><li>能力清单（独立状态）：inventory ${h(report.capabilities.inventoryStatus)}；integration ${h(report.capabilities.integrationStatus)}</li></ul>${families}<h2>任务状态</h2><table><tr><th>任务</th><th>状态</th><th>证据</th><th>剩余</th></tr>${taskRecords.map(task => `<tr><td>${h(task.id)} ${h(task.title)}</td><td class="${h(task.status)}">${h(task.status)}</td><td>${task.evidence.map(e => `<code>${h(commandText(e))}</code>`).join('<br>') || '—'}</td><td>${h(task.remaining?.join('；') ?? '')}</td></tr>`).join('')}</table><h2>矩阵执行</h2><table><tr><th>场景</th><th>原始差异</th><th>原始状态</th></tr>${report.matrix.executed.map(s => `<tr><td>${h(s.scenario)}</td><td>${s.differences}</td><td>${h(s.rawStatus)}</td></tr>`).join('')}</table><h2>边界</h2><ul>${acceptanceBoundaries.map(b => `<li>${h(b)}</li>`).join('')}</ul>${report.issues.length ? `<h2>登记失配</h2><ul>${report.issues.map(i => `<li>${h(i.kind)}: ${h(i.id)} — ${h(i.detail)}</li>`).join('')}</ul>` : ''}</html>`;
}

export function acceptanceStatus(unknown: number, issueCount: number, inventoryFailed: boolean, hasOpenFacts: boolean) {
 const failed = issueCount > 0 || unknown > 0 || inventoryFailed;
 return { status: failed ? 'FAIL' as const : hasOpenFacts ? 'OPEN_ITEMS_REMAIN' as const : 'NO_REGISTERED_OPEN_ITEMS' as const, exitCode: failed ? 1 : 0 };
}

async function buildReport() {
 const issues = validateRegistry();
 const matrix = await runMatrix();
 const { classified, executed } = classifyMatrix(matrix);
 let capabilities: Pick<CapabilityReport, 'inventoryStatus' | 'integrationStatus' | 'openGroups' | 'issues'> | { inventoryStatus: 'FAIL'; integrationStatus: 'UNKNOWN'; openGroups: string[]; issues: unknown[] };
 try { const report = capabilityInventory(); capabilities = { inventoryStatus: report.inventoryStatus, integrationStatus: report.integrationStatus, openGroups: report.openGroups, issues: report.issues }; }
 catch (error) { capabilities = { inventoryStatus: 'FAIL', integrationStatus: 'UNKNOWN', openGroups: [], issues: [String(error)] }; }
 const families: FamilySummary[] = acceptanceFamilies.map(family => ({
  ...family,
  counts: { covered: family.items.filter(i => i.status === 'covered').length, open: family.items.filter(i => i.status === 'open').length, unverified: family.items.filter(i => i.status === 'unverified').length },
 }));
 const items = acceptanceFamilies.flatMap(f => f.items);
 const taskCounts = { accepted: taskRecords.filter(t => t.status === 'accepted').length, partial: taskRecords.filter(t => t.status === 'partial').length, open: taskRecords.filter(t => t.status === 'open').length };
 const familyCounts = { total: families.length, fullyCovered: families.filter(f => f.counts.covered === f.items.length).length, withOpen: families.filter(f => f.counts.open > 0).length, withUnverified: families.filter(f => f.counts.unverified > 0).length };
 const unknown = classified.counts.unknown + classified.semanticIssueCounts.unknown;
 const hasOpenFacts = items.some(i => i.status !== 'covered') || taskCounts.partial > 0 || taskCounts.open > 0;
 // 未知差分与未复核的清单漂移失败；登记表内的 open/unverified 只作为事实呈现。
 const gate = acceptanceStatus(unknown, issues.length, capabilities.inventoryStatus === 'FAIL', hasOpenFacts);
 return {
  schemaVersion: 1,
  ...gate,
  completeness: '登记表只记录列出的证据、open 与缺环境项；不推导"全部接入"。',
  matrix: { executed, counts: classified.counts, semanticIssueCounts: classified.semanticIssueCounts, unknown },
  capabilities,
  registry: { families, familyCounts, taskCounts, items, tasks: taskRecords, boundaries: acceptanceBoundaries },
  issues,
 };
}

export async function main(args = process.argv.slice(2)) {
 let out = '.agent-work/tmp/acceptance';
 for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1] && !args[i + 1]!.startsWith('--')) out = args[++i]!;
  else throw new Error('usage: verify:acceptance [--out DIR]');
 }
 const target = resolve(out);
 mkdirSync(target, { recursive: true });
 try {
  const report = await buildReport();
  writeFileSync(resolve(target, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(resolve(target, 'acceptance.md'), renderMarkdown(report));
  writeFileSync(resolve(target, 'index.html'), renderHtml(report));
  console.log(`[acceptance] ${report.status}; exit ${report.exitCode}; families ${report.registry.familyCounts.total}, tasks accepted ${report.registry.taskCounts.accepted}/partial ${report.registry.taskCounts.partial}/open ${report.registry.taskCounts.open}; unknown ${report.matrix.unknown}; ${target}`);
  for (const issue of report.issues) console.error(`[acceptance] registry issue: ${issue.kind} ${issue.id} — ${issue.detail}`);
  process.exitCode = report.exitCode;
 } catch (error) {
  const failure = { status: 'FAIL', exitCode: 1, error: String(error), completeness: '登记表只记录列出的证据、open 与缺环境项；不推导"全部接入"。' };
  writeFileSync(resolve(target, 'acceptance.json'), JSON.stringify(failure, null, 2) + '\n');
  writeFileSync(resolve(target, 'acceptance.md'), `# 验收与状态总表 FAIL\n\n${String(error)}\n`);
  writeFileSync(resolve(target, 'index.html'), `<!doctype html><meta charset="utf-8"><h1>验收与状态总表 FAIL</h1><pre>${h(String(error))}</pre>`);
  console.error(`[acceptance] FAIL: ${error}`);
  process.exitCode = 1;
 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
