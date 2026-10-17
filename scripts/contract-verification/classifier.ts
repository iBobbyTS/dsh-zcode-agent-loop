import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { diff, hash, packageFile, type Difference } from './oracle.js';

export type Classification = 'intentional' | 'noise' | 'bridge-gap' | 'unknown';
interface Citation { file: string; line: number; sha256: string; role: 'producer' | 'consumer' }
interface Root { id: string; classification: Classification; explanation: string; effect: string; route?: 'dsh-built-in' | 'new-plugin'; owner?: string; sources: Citation[] }
interface Event { type: string; seq: number; data: Record<string, any>; [key: string]: any }
export interface Capture { events: Event[]; ready: Record<string, string[]>; complete: Record<string, string[]>; projections: Record<string, any>; [key: string]: any }
export interface Input { results: { scenario: string; stock: Capture; zcode: Capture; differences: Difference[]; errors: Record<string, string> }[] }
interface Issue { root: string; path: string; stock?: unknown; zcode?: unknown }
interface EventRow { event: Event; index: number; key: string; issues: Issue[]; peer?: EventRow }
export interface Member extends Difference { id: string; scenario: string; root: string; sha256: string; evidence: string[] }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const id = (x: unknown) => typeof x === 'string' && /^<id:\d+>$/.test(x);
function citation(file: string, line: number, role: Citation['role']): Citation {
 const path = file.startsWith('@') ? join(dirname(packageFile(file.split('/').slice(0,2).join('/'))),file.split('/').slice(2).join('/')) : resolve(file);
 return {file,line,sha256:hash(readFileSync(path,'utf8')),role};
}
function root(id: string, classification: Classification, explanation: string, effect: string, producer: [string,number], consumer: [string,number], owner?: string): Root {
 return {id,classification,explanation,effect,...(owner?{route:'dsh-built-in' as const,owner}:{}),sources:[citation(...producer,'producer'),citation(...consumer,'consumer')]};
}
export function roots(): Root[] {
 const loop='@deepseek-ai/dsh-agent-loop/lib/index.js', session='@deepseek-ai/dsh-session/lib/index.js', bridge='src/bridges/event-store-bridge.ts';
 return [
 root('service-name','intentional','The scoped set difference is exactly agentLoop → zcodeLoop. Sorted-array positions amplify one implementation service substitution.','Agents uses the registered factory; shared services remain present. No missing agents/llm/tools service is implied.', ['src/index.ts',265],['@deepseek-ai/dsh-agent/lib/index.js',429]),
 root('inbox-projection','bridge-gap','Stock registers the inbox fold and wire view; ZCode folds splices privately and does not register this projection.','Projection readers cannot request the standard inbox state/view, even when both final private queues are empty.',[loop,26],['@deepseek-ai/dsh-session-projection/lib/index.js',126],'Existing sessionProjections.register / stateOf / wire view; extract or reproduce the loop-owned inbox definition without activating a second loop.'),
 root('system-prefix','intentional','ZCode adds its explicit CLI identity prefix before the same dsh system body. This rule accepts only that exact prefix.','The model receives a different product identity; retained dsh policy body is unchanged.', ['vendor/zcode/apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts',8],[bridge,638]),
 root('request-tools','bridge-gap','Stock persists the admitted tool schemas in request/header; the event bridge writes only provider/model.','requestHeader reconstruction loses the tool snapshot; successful tool execution does not restore the durable request envelope.',[loop,1217],[session,637],'Existing Session request/header / canonicalHeader / foldRequestHeader and ctx.tools.schemas; connect the admitted request tool set.'),
 root('request-context','bridge-gap','The stock request/context event has no aligned ZCode event. This is a missing event, not index noise.','Session.requestContext() has no provider/model/context metadata to fold.',[loop,1264],[session,1627],'Existing prepared LLM call context and Session.requestContext; emit the installed request/context contract.'),
 root('request-header-policy','bridge-gap','ZCode writes a header for every model request and labels later ones change; stock uses header equality and series boundaries.','Redundant headers and a series → change reason alter durable request provenance.',[bridge,678],[session,637],'Existing canonicalHeader/headerEquals and Session request-header folding; mirror stock admission/series rules.'),
 root('stream-chunking','intentional','The ZCode runtime buffers tool input deltas before publishing model_streaming events. Consecutive argument fragments coalesce to exactly the same id/name/index/argument string.','Token arrival granularity changes; argument bytes, blocks and usage must remain equal. Unknown stream fields do not qualify.', ['vendor/zcode/apps/zcode-cli/packages/core/src/runtime/methods/model.ts',184],[bridge,799]),
 root('assistant-tool-surface','bridge-gap','flushPendingAssistant commits on the first scheduled call and clears the pending assistant; the later call is logged separately but its content block never reaches that assistant surface.','A multi-tool assistant surface loses a tool-call block even though both tools execute. This is a missing surface block, not a scheduler-order allowance.',[bridge,985],[session,1491],'Existing dsh assistant/message ContentBlock array and tool-call journal; retain the complete model call set before surface commit.'),
 root('stream-finish','bridge-gap','The bridge marks an incoming finish as consumed without adding its finish chunk, then suppresses its fallback.','Persisted assistant streams lose the terminal reason although text and usage remain. Replay/assembly defaults can conceal truncation or other finish semantics.',[bridge,825],['@deepseek-ai/dsh-llm/lib/index.js',1000],'Existing AssistantStreamAccumulator and dsh finish chunks; preserve the received reason on the durable stream.'),
 root('goal-deferred-context','bridge-gap','update_goal completion defers a tool-goal notice; stock consumes it as next-step inbox and user/message. ZCode tools.execute maps only content/error back to the engine.','The closing instruction and its durable source are absent. The scripted fixture still returns a closing answer and therefore does not prove instruction delivery.', ['@deepseek-ai/dsh-tool-goal/lib/index.js',364],['src/bridges/tool-bridge.ts',178],'Existing dsh tools scheduler deferred context / stock acceptContext callback and next-step inbox; carry deferred context through the bridge. No new host plugin is evidenced.'),
 root('event-position','noise','Matched events are compared independently of their array position. Only fields equal to their semantic peer, or separately classified peer fields, may collapse here.','Raw event order still differs: inbox claim precedes turn/start in ZCode; scheduled tool/call records may precede earlier results. This count is positional amplification, not a claim of equal execution timing.', ['src/agent.ts',286],[loop,906]),
 root('sequence-reference','noise','A seq/sourceEventSeqs/projection boundary value resolves to the same aligned event on each side.','Different event counts/order change numeric offsets without changing the referenced event.',[bridge,1015],[session,315]),
 root('generated-identity','noise','An assistant message paired by turn/step has a different normalized generated id after the missing notice changes identity collection order.','Only a generated assistant message id is treated as statistical noise; source identities/revisions and content are still checked.',[bridge,963],['scripts/contract-verification/oracle.ts',25]),
 root('unknown','unknown','No narrow source-evidenced rule explains this field/event/set difference.','Requires investigation; never inherits an intentional classification from a nearby known difference.',[bridge,1],[session,1491]),
 ];
}
function rows(c: Capture): EventRow[] {
 let turn=0,step=0; const seen=new Map<string,number>();
 return c.events.map((event,index)=>{
  if(event.type==='turn/start'){turn=event.data.turn;step=0;} if(event.type==='step/start')step=event.data.step;
  const d=event.data;
  let key=event.type;
  if(['turn/start','turn/end'].includes(event.type))key+=`:${d.turn}`;
  else if(['step/start','step/end','assistant/message'].includes(event.type))key+=`:${d.turn}:${d.step}`;
  else if(event.type==='request/header')key+=`:${turn}:${step}`;
  else if(event.type==='tool/call')key+=`:${d.callId}`;
  else if(event.type==='tool/result')key+=`:${d.message?.toolCallId}`;
  else if(event.type==='goal/change')key+=`:${d.operation}`;
  else if(event.type==='agent/inbox/spliced')key+=`:${d.target}:${d.inserted?.length?'insert':'claim'}`;
  else if(event.type==='user/message')key+=`:${d.source?.kind}:${d.source?.round??''}`;
  const n=seen.get(key)??0;seen.set(key,n+1);
  return {event,index,key:`${key}#${n}`,issues:[]};
 });
}
function closing(e: Event) { const d=e.data;return e.type==='user/message'&&d.source?.kind==='tool-goal'&&d.source.form==='notice' || e.type==='agent/inbox/spliced'&&d.target==='next-step'&&(d.inserted?.some((m:any)=>m.source?.kind==='tool-goal')||d.inserted?.length===0&&d.removedCount===1); }
function admittedHeader(e: Event) {const d=e.data;return e.type==='request/header' && same(Object.keys(d).sort(),['header','reason']) && same(Object.keys(d.header),['config']) && same(Object.keys(d.header.config).sort(),['model','provider']) && d.reason==='change';}
function coalesce(stream: any[]) {
 const out:any[]=[];
 for(const record of stream){
  const valid=record.type==='tool-call-chunks'&&Object.keys(record).every(k=>['type','args','dt','id','index','name','time0'].includes(k))&&Array.isArray(record.args)&&record.args.every((x:unknown)=>typeof x==='string')&&same(record.dt,[])&&record.time0==='<clock>';
  const prev=out.at(-1);
  if(valid&&prev?.type==='tool-call-chunks'&&prev.id===record.id&&prev.index===record.index&&(record.name===undefined||record.name===prev.name))prev.args=[prev.args.join('')+record.args.join('')];
  else out.push(valid?{...record,args:[record.args.join('')]}:structuredClone(record));
 }
 return out;
}
function finishRecord(r:any){return r?.type==='chunk'&&same(Object.keys(r).sort(),['chunk','time','type'])&&r.time==='<clock>'&&r.chunk?.type==='finish'&&same(Object.keys(r.chunk).sort(),['reason','type'])&&same(Object.keys(r.chunk.reason??{}),['kind'])&&['stop','tool-calls'].includes(r.chunk.reason.kind);}
function eventIssues(a: EventRow, b: EventRow, aa: EventRow[], bb: EventRow[]): Issue[] {
 const sa=a.event.data.stream,sb=b.event.data.stream;
 const missingFinish=Array.isArray(sa)&&Array.isArray(sb)&&finishRecord(sa.at(-1))&&!sb.some((r:any)=>r.chunk?.type==='finish');
 const streamEquivalent=Array.isArray(sa)&&Array.isArray(sb)&&same(coalesce(missingFinish?sa.slice(0,-1):sa),coalesce(sb));
 return diff(a.event,b.event).map(d=>{
  let root='unknown'; const p=d.path;
  if(p==='/seq' && a.event.seq===a.index&&b.event.seq===b.index)root='sequence-reference';
  else if(/^\/sourceEventSeqs\/\d+$/.test(p)&&typeof d.stock==='number'&&typeof d.zcode==='number'&&aa[d.stock]?.peer&&aa[d.stock]!.peer===bb[d.zcode])root='sequence-reference';
  else if(a.event.type==='system/message'&&p==='/data/message/content/0/text'&&d.zcode===`You are ZCode, an interactive coding agent\n\n\n${d.stock}`)root='system-prefix';
  else if(a.event.type==='request/header'&&p==='/data/header/tools'&&d.kind==='removed'&&Array.isArray(d.stock))root='request-tools';
  else if(a.event.type==='request/header'&&p==='/data/reason'&&d.stock==='series'&&d.zcode==='change')root='request-header-policy';
  else if(a.event.type==='assistant/message'&&p.startsWith('/data/stream/')&&streamEquivalent)root=missingFinish&&p===`/data/stream/${sa.length-1}`?'stream-finish':'stream-chunking';
  else if(a.event.type==='assistant/message'&&/^\/data\/message\/content\/\d+$/.test(p)&&d.kind==='removed'&&(d.stock as any)?.type==='tool-call'&&aa.some(r=>r.event.type==='tool/call'&&r.event.data.callId===(d.stock as any).id&&r.peer&&same(r.event.data,r.peer.event.data)))root='assistant-tool-surface';
  else if(a.event.type==='assistant/message'&&p==='/data/message/id'&&id(d.stock)&&id(d.zcode)){
   const missingIds=aa.filter(r=>r.index<a.index&&!r.peer&&r.event.type==='user/message'&&closing(r.event)).length;
   if(missingIds>0&&Number(String(d.stock).slice(4,-1))-Number(String(d.zcode).slice(4,-1))===missingIds)root='generated-identity';
  }
  return {root,...d};
 });
}
export function classify(input: Input) {
 const definitions=roots(),members:Member[]=[],facts:{scenario:string;root:string;stock?:string;zcode?:string;path:string;detail:unknown}[]=[],registrations:unknown[]=[];
 if(new Set(input.results.map(r=>r.scenario)).size!==input.results.length)throw new Error('duplicate scenario');
 for(const result of input.results) {
  if(Object.keys(result.errors??{}).length)throw new Error(`failed capture: ${result.scenario}`);
  const actual=diff(result.stock,result.zcode);
  if(!same(actual,result.differences))throw new Error(`stale raw differences: ${result.scenario}`);
  const a=rows(result.stock),b=rows(result.zcode);
  for(const x of a){const y=b.find(y=>y.key===x.key);if(y){x.peer=y;y.peer=x;}}
  for(const x of a)if(x.peer){x.issues=eventIssues(x,x.peer,a,b);x.peer.issues=x.issues;}else x.issues=[{path:'',root:x.event.type==='request/context'&&same(Object.keys(x.event.data).sort(),['model','provider'])?'request-context':closing(x.event)?'goal-deferred-context':'unknown',stock:x.event}];
  for(const y of b)if(!y.peer)y.issues=[{path:'',root:admittedHeader(y.event)?'request-header-policy':'unknown',zcode:y.event}];
  for(const x of a)for(const issue of x.issues)facts.push({scenario:result.scenario,root:issue.root,stock:`/events/${x.index}`,zcode:x.peer?`/events/${x.peer.index}`:undefined,path:issue.path,detail:issue});
  for(const y of b)if(!y.peer)for(const issue of y.issues)facts.push({scenario:result.scenario,root:issue.root,zcode:`/events/${y.index}`,path:issue.path,detail:issue});
  const sets=new Map<string,{missing:string[];extra:string[]}>();
  for(const phase of ['ready','complete'])for(const registry of ['services','projections','tools']){
   const s:string[]=result.stock[phase][registry]??[],z:string[]=result.zcode[phase][registry]??[];
   const delta={missing:s.filter(k=>!z.includes(k)),extra:z.filter(k=>!s.includes(k))};sets.set(`${phase}/${registry}`,delta);
   if(delta.missing.length||delta.extra.length)registrations.push({scenario:result.scenario,phase,registry,...delta});
  }
  for(const [i,d]of actual.entries()) {
   let root='unknown';let evidence:string[]=[];const m=d.path.match(/^\/events\/(\d+)(.*)$/);
   if(m){const n=Number(m[1]),p=m[2]!;const x=a[n],y=b[n];
    const issues=[...(x?.issues??[]),...(y?.issues??[])].filter(q=>!p||!q.path||q.path===p||q.path.startsWith(`${p}/`)||p.startsWith(`${q.path}/`));
    // Unknown on either semantic side always wins over positional explanations.
    root=issues.some(q=>q.root==='unknown')?'unknown':issues.find(q=>!['sequence-reference','generated-identity'].includes(q.root))?.root??issues[0]?.root??'event-position';
    evidence=[x?`stock /events/${n} → ${x.peer?`zcode /events/${x.peer.index}`:'missing'}`:'stock absent',y?`zcode /events/${n} → ${y.peer?`stock /events/${y.peer.index}`:'extra'}`:'zcode absent'];
   } else {
    const reg=d.path.match(/^\/(ready|complete)\/(services|projections)\/\d+$/);
    if(reg){const delta=sets.get(`${reg[1]}/${reg[2]}`)!;if(reg[2]==='services'&&same(delta,{missing:['agentLoop'],extra:['zcodeLoop']}))root='service-name';else if(reg[2]==='projections'&&same(delta,{missing:['inbox'],extra:[]}))root='inbox-projection';evidence=[JSON.stringify(delta)];}
    else if(d.path==='/projections/inbox'&&d.kind==='removed')root='inbox-projection';
    else if(/^\/projections\/turnBoundary\/(lastStepBoundary\/seq|lastStepStartSeq)$/.test(d.path)&&typeof d.stock==='number'&&typeof d.zcode==='number'&&a[d.stock]?.peer&&a[d.stock]!.peer===b[d.zcode])root='sequence-reference';
   }
   members.push({...d,id:`${result.scenario}:${i+1}`,scenario:result.scenario,root,sha256:hash(JSON.stringify(d)),evidence});
  }
 }
 const groups=definitions.map(r=>({...r,count:members.filter(m=>m.root===r.id).length,scenarios:[...new Set(members.filter(m=>m.root===r.id).map(m=>m.scenario))],scenarioCounts:Object.fromEntries([...new Set(members.filter(m=>m.root===r.id).map(m=>m.scenario))].map(s=>[s,members.filter(m=>m.root===r.id&&m.scenario===s).length])),samples:members.filter(m=>m.root===r.id).slice(0,3).map(m=>m.id),members:members.filter(m=>m.root===r.id).map(m=>m.id),semanticFacts:facts.filter(f=>f.root===r.id)})).filter(g=>g.count||g.semanticFacts.length);
 const counts={raw:members.length,groups:groups.length,...Object.fromEntries((['intentional','noise','bridge-gap','unknown'] as const).map(c=>[c,members.filter(m=>definitions.find(r=>r.id===m.root)!.classification===c).length])) as Record<Classification,number>};
 return {schemaVersion:1,status:counts.unknown?'UNKNOWN':'CLASSIFIED',equivalence:'FAIL',counts,registrations,groups,members};
}
