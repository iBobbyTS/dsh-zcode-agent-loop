import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import GoalPlugin from "@deepseek-ai/dsh-goal";
import * as GoalRoundDriver from "@deepseek-ai/dsh-goal-round-driver";
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId as DshToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as ToolGoal from "@deepseek-ai/dsh-tool-goal";
import * as ToolTodo from "@deepseek-ai/dsh-tool-todo";

import ZcodeLoop from "../../src/index.js";


import { installedRequire } from "./oracle.js";
import { pathToFileURL } from "node:url";
export type Scenario = "basic-text"|"todo-tool"|"goal-round"|"tool-round-trip"|"cancel-mid-stream"|"queued-followup";
const tcid = (id: string) => DshToolCallId(id);

interface ScriptedCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

function response(text: string, calls: ScriptedCall[] = []): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
  ];
  let index = 1;
  for (const call of calls) {
    const argumentsJson = JSON.stringify(call.args);
    chunks.push({ type: "block-start", index, blockType: "tool-call" });
    chunks.push({
      type: "tool-call-delta",
      index,
      id: tcid(call.callId),
      name: call.name,
      argumentsDelta: argumentsJson.slice(0, 5),
    });
    chunks.push({ type: "tool-call-delta", index, id: tcid(call.callId), argumentsDelta: argumentsJson.slice(5) });
    chunks.push({
      type: "block-end",
      index,
      block: { type: "tool-call", id: tcid(call.callId), name: call.name, arguments: argumentsJson },
    });
    index += 1;
  }
  chunks.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
  chunks.push({ type: "finish", reason: calls.length > 0 ? { kind: "tool-calls" } : { kind: "stop" } });
  return chunks;
}

/** goal 剧本 adapter：按请求序号派发；R3 从 goals 服务取当前 goal（勿解析转义 JSON）。 */
class GoalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(readonly scenario: Scenario) { super(); }
  /** 由 main 注入：R3 时直接从 goals 服务取当前 goal。 */
  getGoal: () => GoalView | undefined = () => undefined;
  /** 场景钩子：取消与排队必须在真实流中间触发，不能在流结束后补发。 */
  afterChunk?: (chunk: StreamChunk) => void;

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const n = this.requests.length;
    if (this.scenario === "basic-text") { if(n !== 1) throw new Error("extra basic request"); yield* response("fixture reply"); return; }
    if (this.scenario === "todo-tool") { if(n===1) yield* response("write todo", [{callId:"todo-1",name:"todo_write",args:{todos:[{content:"fixture",status:"pending"}]}}]); else if(n===2) yield* response("done"); else throw new Error("extra todo request"); return; }
    if (this.scenario === "tool-round-trip") {
      if (n === 1) yield* response("round one", [{callId:"round-1",name:"todo_write",args:{todos:[{content:"round one",status:"in_progress"}]}}]);
      else if (n === 2) yield* response("round two", [{callId:"round-2",name:"todo_write",args:{todos:[{content:"round one",status:"completed"},{content:"round two",status:"pending"}]}}]);
      else if (n === 3) yield* response("round trip complete");
      else throw new Error("extra tool round-trip request");
      return;
    }
    if (this.scenario === "cancel-mid-stream") {
      if (n !== 1) throw new Error("extra cancel request");
      for (const chunk of [
        { type: "block-start", index: 0, blockType: "text" } as const,
        { type: "text-delta", index: 0, text: "VISIBLE_PREFIX" } as const,
      ]) { yield chunk; this.afterChunk?.(chunk); }
      return;
    }
    if (this.scenario === "queued-followup") {
      if (n === 1) { for (const chunk of response("first turn complete")) { yield chunk; this.afterChunk?.(chunk); } return; }
      if (n === 2) { yield* response("queued turn complete"); return; }
      throw new Error("extra queued-followup request");
    }
    if (n === 1) {
      yield* response("好的：先创建目标并写入任务清单。", [
        { callId: "call-goal-create", name: "create_goal", args: { objective: "完成goal-chain验收", max_goal_rounds: 3 } },
        {
          callId: "call-todo-1",
          name: "todo_write",
          args: {
            todos: [
              { content: "创建目标", status: "in_progress" },
              { content: "完成目标", status: "pending" },
            ],
          },
        },
      ]);
      return;
    }
    if (n === 2) {
      yield* response("第一轮完成：目标已创建，任务清单已写入。");
      return;
    }
    if (n === 3) {
      const goal = this.getGoal();
      if (goal === undefined) {
        throw new Error("round-2 request arrived but no live goal found in goals service");
      }
      yield* response("目标续轮：读取到当前目标，现在标记完成。", [
        { callId: "call-goal-complete", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "complete" } },
      ]);
      return;
    }
    if (n === 4) {
      yield* response("目标已完成，不再续轮。");
      return;
    }
    throw new Error(`unexpected request #${n} (round 3 must not fire)`);
  }
}

interface GoalView {
  id: string;
  revision: number;
  phase: string;
  roundsStarted: number;
  maxGoalRounds: number;
}

interface GoalMessageSource {
  kind: "goal";
  goalId: string;
  revision: number;
  round: number;
}


function assert(value: unknown, message: string): asserts value { if(!value) throw new Error(message); }
async function deadline<T>(p: Promise<T>, label: string, ms=12000):Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try {return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`timeout: ${label}`)),ms);})]);} finally {clearTimeout(timer);} }
async function waitFor(predicate:()=>boolean,label:string) { await deadline((async()=>{while(!predicate()) await new Promise(r=>setTimeout(r,20));})(),label); }
export const fixturePlugins = ["llm","session","system-prompt","tools","session-projection","goal","goal-round-driver","tool-todo","tool-goal","agent"].map(n=>`@deepseek-ai/dsh-${n}`);
export async function runFixture(engine:"stock"|"zcode", scenario:Scenario, mutation?:"missing-turnBoundary") {
 const ctx=new Context(); let handle: Awaited<ReturnType<typeof ctx.agents.create>>|undefined;
 try {
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt,{}); await ctx.plugin(ToolRuntime,{}); await ctx.plugin(SessionProjection);
  // Public projection registration instrumentation, before any dependent plugin activates.
  // Mutation exercises a real loop activation, without editing production sources.
  const register=ctx.sessionProjections.register.bind(ctx.sessionProjections);
  ctx.sessionProjections.register=((definition: Parameters<typeof register>[0])=>{ if(mutation==='missing-turnBoundary'&&definition.key==='turnBoundary') return ()=>{}; return register(definition); }) as typeof register;
  await ctx.plugin(GoalPlugin,{}); await ctx.plugin(GoalRoundDriver);
  await ctx.plugin(ToolTodo as unknown as Plugin.Object<{allowParallelInProgress:boolean}>,{allowParallelInProgress:true}); await ctx.plugin(ToolGoal as unknown as Plugin); await ctx.plugin(AgentRegistry);
  const stock = engine==='stock' ? (await import(pathToFileURL(installedRequire.resolve('@deepseek-ai/dsh-agent-loop')).href)).default as Plugin : ZcodeLoop;
  await ctx.plugin(stock as Plugin,{provider:'mock',model:'mock'});
  const adapter=new GoalAdapter(scenario); ctx.llm.registerAdapter(['mock'],adapter);
  const registration=()=>({projections:Object.keys(ctx.sessionProjections.checkpoint(handle!.agent.session)).sort(),tools:ctx.tools.schemas().map(t=>t.name).sort(),
    // Cordis has no public service enumeration. reflect.props is its installed
    // implementation's declared registry; filter out accessors/mixins via get.
    services:Object.keys((ctx as unknown as {reflect:{props:Record<string,unknown>}}).reflect.props).filter(k=>{const property=ctx.reflect.props[k];return property?.type==='service' && ctx.get(k)!==undefined;}).sort()});
  handle=await deadline(ctx.agents.create({sessionId:DshSessionId('contract-fixture'),agentOptions:{provider:'mock',model:'mock'}}),'create');
  const agent=handle.agent; const goals=ctx.get('goals') as unknown as {get:(a:Agent)=>GoalView|undefined}; adapter.getGoal=()=>goals.get(agent);
  // 取消/排队只能在流中间发生；钩子由场景决定，避免在流结束后补触发。
  let cancelled=false, queued=false;
  if(scenario==='cancel-mid-stream') adapter.afterChunk=chunk=>{ if(!cancelled&&chunk.type==='text-delta'){cancelled=true;agent.cancel({kind:'user'});} };
  if(scenario==='queued-followup') adapter.afterChunk=chunk=>{ if(!queued&&chunk.type==='text-delta'){queued=true;agent.followup(createUserMessage({content:[{type:'text',text:'queued fixture input'}],source:{kind:'user'}}));} };
  const ready=registration();
  assert(ready.tools.includes('todo_write')&&ready.tools.includes('create_goal')&&ready.tools.includes('update_goal'),'fixture plugins not activated');
  agent.followup(createUserMessage({content:[{type:'text',text:'contract fixture input'}],source:{kind:'user'}}));
  const expected=scenario==='basic-text'||scenario==='cancel-mid-stream'?1:scenario==='todo-tool'||scenario==='queued-followup'?2:scenario==='tool-round-trip'?3:4;
  await waitFor(()=>adapter.requests.length>=expected,'model requests'); await deadline(agent.whenIdle(),'idle');
  if(scenario==='goal-round') await waitFor(()=>goals.get(agent)?.phase==='complete','goal complete');
  await new Promise(r=>setTimeout(r,100)); await deadline(agent.whenIdle(),'quiescence');
  assert(adapter.requests.length===expected,`expected ${expected} requests, got ${adapter.requests.length}`);
  const events=agent.session.snapshotEvents();
  assert(events.some(e=>e.type==='user/message'&&(e.data as {source?:{kind?:string}}).source?.kind==='user'),'user source not triggered');
  if(['todo-tool','tool-round-trip','goal-round'].includes(scenario)) assert(events.some(e=>e.type==='todo/write'),'todo not triggered');
  if(scenario==='tool-round-trip') { assert(events.filter(e=>e.type==='tool/call').length===2,'tool round-trip call count'); assert(events.filter(e=>e.type==='tool/result').length===2,'tool round-trip result count'); assert(events.filter(e=>e.type==='todo/write').length===2,'tool round-trip must return to the model twice'); }
  if(scenario==='cancel-mid-stream') { const end=events.findLast(e=>e.type==='turn/end'); assert(end?.type==='turn/end'&&(end.data as {reason?:{kind?:string}}).reason?.kind==='aborted','cancel must close the turn as aborted'); assert(JSON.stringify(agent.session.deriveMessages()).includes('VISIBLE_PREFIX'),'visible prefix lost on cancel'); }
  if(scenario==='queued-followup') { assert(events.filter(e=>e.type==='turn/start').length===2,'queued follow-up turn missing'); assert(events.filter(e=>e.type==='user/message').length===2,'queued follow-up source missing'); }
  if(scenario==='goal-round') { const goal=goals.get(agent); assert(goal?.phase==='complete','goal not complete'); const source=events.filter(e=>e.type==='user/message').map(e=>(e.data as {source?:GoalMessageSource}).source).find(s=>s?.kind==='goal'); assert(source&&source.goalId===goal.id&&source.round===1&&source.revision>=1,'goal source mismatch'); assert(JSON.stringify(adapter.requests[2]?.messages).includes('<goal_round>'),'round prompt absent'); assert(!JSON.stringify(events.filter(e=>e.type.startsWith('tool/'))).includes('GOAL_TOOL_'),'authority rejection'); }
  const complete=registration(); const projections=Object.fromEntries(complete.projections.map(k=>[k,ctx.sessionProjections.stateOf(agent.session,k as never)]));
  return {ready,complete,events,projections,assertions:{requests:adapter.requests.length,goal:scenario==='goal-round'?goals.get(agent):null}};
 } finally {
  const errors:unknown[]=[];
  if(handle) await deadline(Promise.resolve(handle.dispose()),'handle cleanup',1000).catch(e=>errors.push(e));
  await deadline(Promise.resolve(ctx.fiber.dispose()),'context cleanup',1000).catch(e=>errors.push(e));
  if(errors.length) throw new AggregateError(errors,'fixture cleanup failed');
 }
}
