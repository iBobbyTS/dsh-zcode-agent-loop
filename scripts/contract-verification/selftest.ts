import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalize, diff, applyAllowances, scanSource, familyMatrix, profiles } from './oracle.js';
import { capture, scenarios, exitStatus } from './runner.js';
const checks: {name:string;status:string}[]=[];
function check(name:string, action:()=>void) {action();checks.push({name,status:'PASS'});console.log(`[contracts:selftest] PASS ${name}`);}
const reportPath=resolve(process.argv[2]??'.agent-work/tmp/contract-verification/report.json');
const report=JSON.parse(await readFile(reportPath,'utf8')) as {results:{scenario:string;stock:unknown;zcode:unknown;errors:Record<string,string>}[]};
assert.equal(report.results.length,scenarios.length,'run verify:matrix before selftest');
for(const row of report.results) assert.deepEqual(row.errors,{},`${row.scenario} must contain real successful captures`);
const base=report.results.find(r=>r.scenario==='goal-round')!.stock as {events:{type:string;data:Record<string,unknown>}[];projections:Record<string,unknown>;ready:{projections:string[]}};
function mutation(name:string, mutate:(copy:typeof base)=>void) {check(name,()=>{const copy=structuredClone(base);mutate(copy);const failures=applyAllowances('goal-round',diff(base,copy),[]).unallowed;assert(failures.length>0,`${name} was swallowed`);});}
mutation('source loss',r=>{const e=r.events.find(e=>e.type==='user/message')!;delete e.data.source;});
mutation('GOAL_TOOL error semantics',r=>{const message=r.events.find(e=>e.type==='tool/result')!.data.message as {isError:boolean;content:unknown[]};message.isError=true;message.content=[{type:'text',text:'GOAL_TOOL_NO_AUTHORITY'}];});
mutation('unknown field',r=>{r.events[0]!.data.unknownContractField={enabled:true};});
mutation('extra event',r=>{r.events.push({type:'unknown/event',data:{}});});
mutation('extra projection',r=>{r.projections.newProjection={unknown:1};});
mutation('source revision',r=>{const e=r.events.find(e=>e.type==='user/message'&&(e.data.source as {kind:string})?.kind==='goal')!;(e.data.source as {revision:number}).revision++;});
check('normalizer preserves source revision and unknown values',()=>{assert(diff(normalize({source:{revision:1},unknown:4}),normalize({source:{revision:2},unknown:5})).length===2);});
check('normalizer preserves equality references',()=>{const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';assert(diff(normalize({role:'user',id:a,source:{kind:'goal',goalId:a}} ),normalize({role:'user',id:a,source:{kind:'goal',goalId:b}})).length>0);});
check('unknown clock-shaped fields preserved',()=>{assert(diff(normalize({unknown:{time:1,createdAt:2,id:'11111111-1111-4111-8111-111111111111'}}),normalize({unknown:{time:2,createdAt:3,id:'22222222-2222-4222-8222-222222222222'}})).length===3);});
check('broad allowance rejected',()=>{assert.throws(()=>applyAllowances('goal-round',[],[{scenario:'goal-round',path:'/events/*',kind:'value',reason:'test',source:'test'}]));});
check('stale allowance exposed',()=>{assert.equal(applyAllowances('goal-round',[],[{scenario:'goal-round',path:'/events/0/type',kind:'value',stock:'a',zcode:'b',reason:'test',source:'test'}]).stale.length,1);});
check('allowances bind exact values and scenarios',()=>{const a={scenario:'basic-text',path:'/x',kind:'value' as const,stock:1,zcode:2,reason:'test',source:'test'};assert.equal(applyAllowances('goal-round',diff({x:1},{x:2}),[a]).unallowed.length,1);assert.equal(applyAllowances('basic-text',diff({x:1},{x:3}),[a]).unallowed.length,1);assert.equal(applyAllowances('basic-text',diff({x:1},{x:2}),[a]).allowed,1);});
check('new stock obligation stays unknown; fingerprint changes',()=>{const a=scanSource('ctx.on("a", listener);','lib/test.js');const b=scanSource('ctx.on("b", listener);ctx.session.append("new", value);','lib/test.js');assert.equal(b.length,a.length+1);assert.notEqual(a[0]!.fingerprint,b[0]!.fingerprint);assert(b.every(r=>r.status==='unknown'));assert.equal(a[0]!.fingerprint,scanSource('\nctx.on("a", listener);','lib/test.js')[0]!.fingerprint);});
check('source fingerprint preserves literal whitespace changes',()=>{assert.notEqual(scanSource('ctx.on("a  b", listener);','lib/test.js')[0]!.fingerprint,scanSource('ctx.on("a b", listener);','lib/test.js')[0]!.fingerprint);});
check('strict coverage exit gate',()=>{assert.equal(exitStatus('PASS','partial',true),2);assert.equal(exitStatus('PASS','partial',false),0);assert.equal(exitStatus('FAIL','complete',false),1);});
check('new profile family has no scenario',()=>{assert.equal(familyMatrix(['new/plugin'],{})[0]!.status,'no-scenario');});
check('shipped nested preset and group plugins are enumerated',()=>{
 const profile=profiles();
 assert(profile.names.includes('@deepseek-ai/dsh-persona'),'preset plugin missing');
 assert(profile.names.includes('@deepseek-ai/dsh-tool-bash-persistent'),'nested group plugin missing');
 assert(profile.rows.some(r=>r.id==='preset-standard')&&profile.rows.some(r=>r.id==='preset-cordis'),'bundle patch declarations were not composed');
});
// Real activation mutation: removing the production projection registration is
// observable at L1; no synthetic capture can satisfy this check.
const mutated=normalize(await capture('zcode','basic-text','missing-turnBoundary')) as typeof base;
check('real missing turnBoundary registration',()=>{assert(!mutated.ready.projections.includes('turnBoundary'));assert(diff(report.results.find(r=>r.scenario==='basic-text')!.zcode,mutated).some(d=>d.path.startsWith('/ready/projections')));});
// A second fresh run of every fixture must produce the identical normalized
// artifact. This catches nondeterministic fields even when execution is FAIL.
for(const scenario of scenarios) for(const engine of ['stock','zcode'] as const) {
 const captured=normalize(await capture(engine,scenario));const prior=report.results.find(r=>r.scenario===scenario)![engine];
 check(`repeat ${engine}/${scenario}`,()=>{assert.deepEqual(captured,prior);});
}
await mkdir(resolve('.agent-work/tmp/contract-verification'),{recursive:true});
await writeFile(resolve('.agent-work/tmp/contract-verification/selftest.json'),JSON.stringify({status:'PASS',sourceReport:reportPath,checks},null,2)+'\n');
console.log(`[contracts:selftest] PASS ${checks.length} checks`);
