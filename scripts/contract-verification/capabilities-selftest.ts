import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessCapabilities, capabilityExit, capabilityInventory, manifestPath, scanEngine, scanWiring, type Manifest } from './capabilities.js';
import { runCheck } from './check.js';
import type { runMatrix } from './runner.js';

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const inventory = capabilityInventory();
let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`[capabilities:selftest] PASS ${name}`); }
function changed(fileSuffix: string, replace: (s: string) => string) {
 return scanEngine(file => { const text = readFileSync(file, 'utf8'); return file.endsWith(fileSuffix) ? replace(text) : text; });
}
function unknown(surfaces: ReturnType<typeof scanEngine>, id: string) {
 const report = assessCapabilities(surfaces, manifest);
 assert(report.issues.some(i => i.id === id));
 assert.equal(report.inventoryStatus, 'FAIL'); assert.equal(report.integrationStatus, 'UNKNOWN'); assert.equal(capabilityExit(report), 1);
 return report;
}
check('real inventory accounts each discovered surface once, without calling integration complete', () => {
 assert.equal(inventory.inventoryStatus, 'PASS'); assert.equal(inventory.integrationStatus, 'INCOMPLETE');
 assert.equal(new Set(inventory.rows.map(r => r.id)).size, inventory.total);
 assert.equal(Object.values(inventory.counts).reduce((a, b) => a + b, 0), inventory.total);
 assert.equal(inventory.counts.unknown, 0); assert(inventory.counts['not-integrated'] > 0); assert(inventory.counts['host-incompatible'] > 0);
 assert.equal(capabilityExit(inventory), 0); assert.equal(capabilityExit(inventory, true), 2);
});
check('unexercised rewind, checkpoint, side conversation, memory and manual compact have explicit gaps', () => {
 for (const id of ['api.rewindConversationToMessage', 'api.applyWorkspaceFileRewind', 'api.createSelectionSideConversation', 'config.memory', 'memory.extractionEnabled', 'admission.commandKind', 'tool.jsToolEntry']) assert.equal(inventory.rows.find(r => r.id === id)?.disposition, 'not-integrated', id);
 assert.equal(inventory.rows.find(r => r.id === 'tool.bashToolEntry')?.disposition, 'dsh-alternative');
 assert.equal(inventory.rows.find(r => r.id === 'deps.agentTelemetry')?.disposition, 'host-incompatible');
});
check('a new public API becomes unknown, even with no new mock scenario', () => {
 unknown(changed('/runtime/agent-runtime.ts', s => s.replace('export interface AgentRuntime {', 'export interface AgentRuntime { newHostFeature(): void;')), 'api.newHostFeature');
});
check('new dependency, turn option, memory setting, compact setting and built-in tool cannot inherit a category', () => {
 for (const [suffix, oldText, newText, id] of [
  ['/runtime/types.ts', 'export interface AgentRuntimeDeps {', 'export interface AgentRuntimeDeps { newPort?: string;', 'deps.newPort'],
  ['/runtime/types.ts', 'export interface ExecuteTurnOptionsBase {', 'export interface ExecuteTurnOptionsBase { newOption?: boolean;', 'turn.newOption'],
  ['/runtime/types.ts', 'export interface MemoryRuntimeConfig {', 'export interface MemoryRuntimeConfig { newRecall?: boolean;', 'memory.newRecall'],
  ['/compact/policy.ts', 'export interface AutoCompactPolicyConfig {', 'export interface AutoCompactPolicyConfig { newPolicy?: boolean;', 'compact.newPolicy'],
  ['/tool/handlers/index.ts', 'export const builtInTools: ToolEntry[] = [', 'export const builtInTools: ToolEntry[] = [newNativeToolEntry,', 'tool.newNativeToolEntry'],
 ]) unknown(changed(suffix!, s => s.replace(oldText!, newText!)), id!);
});
check('changed API or nested configuration signature requires reassessment', () => {
 unknown(changed('/runtime/agent-runtime.ts', s => s.replace('getMode(): CollaborationMode;', 'getMode(): string;')), 'api.getMode');
 unknown(changed('/runtime/types.ts', s => s.replace('runtimeFeatures?: {', 'runtimeFeatures?: { newFeature?: boolean;')), 'config.runtimeFeatures');
});
check('removed public surface cannot disappear from the ledger silently', () => {
 const report = unknown(scanEngine().filter(s => s.id !== 'api.rewindConversationToMessage'), 'api.rewindConversationToMessage');
 assert(report.issues.some(i => i.kind === 'removed-surface'));
});
check('public inheritance cannot silently bypass scanning', () => {
 assert.throws(() => changed('/runtime/types.ts', s => s.replace('export interface AgentRuntimeConfig {', 'export interface AgentRuntimeConfig extends AddedConfig {')), /inherits members/);
});
check('duplicate classification and stale evidence are rejected', () => {
 const duplicate = structuredClone(manifest); duplicate.groups[1]!.members = { ...duplicate.groups[1]!.members, ...duplicate.groups[0]!.members };
 assert.throws(() => assessCapabilities(scanEngine(), duplicate), /Duplicate capability/);
 const stale = structuredClone(manifest); stale.groups[0]!.evidence[0]!.needle = 'nonexistent-bridge-evidence';
 assert.throws(() => assessCapabilities(scanEngine(), stale), /Stale capability evidence/);
});
check('production wiring changes require reassessment and test/façade references do not prove an entry', () => {
 const wiring = scanWiring();
 assert(wiring.some(r => r.id === 'api.executeTurn' && r.file === 'src/agent.ts'));
 assert(!wiring.some(r => r.id === 'api.rewindConversationToMessage'));
 const report = assessCapabilities(scanEngine(), manifest, [...wiring, { id: 'api.rewindConversationToMessage', file: 'src/agent.ts', line: 1, fingerprint: 'new-call' }]);
 assert(report.issues.some(i => i.kind === 'wiring-changed')); assert.equal(capabilityExit(report), 1);
});

const matrix = JSON.parse(await readFile(process.argv[2] ?? '.agent-work/tmp/contract-classification/report/matrix/report.json', 'utf8')) as Awaited<ReturnType<typeof runMatrix>>;
const scratch = await mkdtemp(join(tmpdir(), 'capability-status-'));
try {
 assert.equal(await runCheck(scratch, false, async () => matrix), 0);
 const gate = JSON.parse(await readFile(join(scratch, 'check.json'), 'utf8'));
 assert.equal(gate.status, 'INCOMPLETE'); assert.equal(gate.scenarioStatus, 'PASS'); assert.equal(gate.overallStatus, 'INCOMPLETE'); assert.equal(gate.capabilityIntegration, 'INCOMPLETE');
 const html = await readFile(join(scratch, 'index.html'), 'utf8'); assert(html.includes('能力入口统计：INCOMPLETE')); assert(html.includes('未接入')); assert(html.includes('dsh 已有替代')); assert(html.includes('无法直接桥接')); assert(html.includes('Executed scenario raw differences'));
 assert.equal(await runCheck(scratch, false, async () => matrix, capabilityInventory, true), 2);
 checks++; console.log('[capabilities:selftest] PASS combined report separates passing scenarios from incomplete capabilities; strict integration exits 2');
 const unclassified = unknown(changed('/runtime/agent-runtime.ts', s => s.replace('export interface AgentRuntime {', 'export interface AgentRuntime { newHostFeature(): void;')), 'api.newHostFeature');
 assert.equal(await runCheck(scratch, false, async () => matrix, () => unclassified), 1);
 const failed = JSON.parse(await readFile(join(scratch, 'check.json'), 'utf8')); assert.equal(failed.status, 'FAIL'); assert.equal(failed.scenarioStatus, 'PASS'); assert.equal(failed.overallStatus, 'FAIL');
 assert((await readFile(join(scratch, 'capabilities.html'), 'utf8')).includes('api.newHostFeature'));
 checks++; console.log('[capabilities:selftest] PASS unknown capability fails combined gate despite passing all three scenarios');
 assert.equal(await runCheck(scratch, false, async () => matrix, () => { throw new Error('stale evidence <unsafe>'); }), 1);
 assert.equal(JSON.parse(await readFile(join(scratch, 'capabilities.json'), 'utf8')).inventoryStatus, 'FAIL');
 const failureHtml = await readFile(join(scratch, 'capabilities.html'), 'utf8'); assert(failureHtml.includes('Capability inventory FAIL')); assert(failureHtml.includes('&lt;unsafe&gt;')); assert(!failureHtml.includes('能力入口统计：INCOMPLETE'));
 checks++; console.log('[capabilities:selftest] PASS inventory failure replaces stale capability artifacts');
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log(`[capabilities:selftest] PASS ${checks} checks`);
