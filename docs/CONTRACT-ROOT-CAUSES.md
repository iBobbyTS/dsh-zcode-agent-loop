# Original 289 contract differences

The original npm stock differential is fully assigned: **289 raw members, 13 root groups, 67 intentional, 131 noise, 91 bridge-gap, 0 unknown**. These are raw field counts, not a count of independent missing features. Classification does not establish equivalence: the matrix remains FAIL with its existing empty allowance list.

Authority is installed `@deepseek-ai/dsh@0.2.1-alpha.5`, its same-version stock loop and the actual installed session, LLM, tool and projection consumers. The ZCode `src/` bridge is the other producer; vendored ZCode is cited only for its engine buffering behavior. Reference sources do not substitute for installed stock.

## Run and inspect

```sh
# Current runtime report (run verify:matrix first; its differential exit 1 is expected).
pnpm verify:classify
pnpm verify:classify --input .agent-work/tmp/contract-verification/report.json --out /tmp/current-contract-classification
# Original frozen input available in this work session.
pnpm verify:classify --input .agent-work/tmp/contract-classification/baseline-289.json
pnpm verify:classify:selftest
pnpm typecheck
```

Default input is `.agent-work/tmp/contract-verification/report.json`; default output is `.agent-work/tmp/contract-classification/report/`. Open `index.html` in a browser: totals, root groups, scoped registration set differences, source citations/hashes, aligned semantic facts and every raw member are available without a build or network dependency. `classification.json`, `report.md` and `raw-differences.json` are companion artifacts. HTML source/content and Markdown angle brackets are escaped.

Exit **0** means all current differences have an evidenced assignment, including real gaps. Exit **1** means unknown differences or invalid/mismatched input. Package versions/hashes must match the installed pinned authority. Raw differences are recomputed and compared with the input, so a stale difference list fails. Neither a classification success nor fixture assertions approve production allowances.

The durable [original ledger](CONTRACT-ORIGINAL-289.json) retains every original member's scenario, pointer, kind, normalized stock/ZCode values, full-difference SHA256 and primary root, plus root source citations/hashes. It is about 100 KB rather than the full 420 KB runtime report. Its baseline SHA256 is **2b28b0ee92eb772f30a24c4012b25655df30d5ed1ebb7e88de25fefa5e5d3fac** (the JSON's `baseline.sha256` is authoritative). Original membership is immutable evidence; rerunning the classifier on current captures writes separate generated reports and does not update this ledger. `--ledger NEW_PATH` creates a ledger exclusively and refuses an existing path.

## Root ledger

| Root | Category | Raw members | Scenarios | Material effect / route |
| --- | --- | ---: | --- | --- |
| service-name | intentional | 48 | all 3 | One scoped service substitution `agentLoop → zcodeLoop`; the alphabetical arrays amplify this into 48 fields. `agents`, `llm`, `tools` and the other shared services are still present. |
| inbox-projection | bridge-gap | 21 | all 3 | `inbox` registration/state/wire view absent. **dsh-built-in**: register the loop-owned fold through existing `sessionProjections`, without activating a second agent loop. |
| system-prefix | intentional | 3 | all 3 | Exact ZCode CLI identity prefix before the unchanged dsh system body. |
| request-tools | bridge-gap | 4 | all 3 | Durable request header loses tool schemas. **dsh-built-in**: admitted tool schemas, `canonicalHeader` and session request-header folding. |
| request-context | bridge-gap | 27 | all 3 | Three actual missing context events produce many shifted fields. **dsh-built-in**: prepared LLM context and `Session.requestContext()`. |
| request-header-policy | bridge-gap | 11 | todo-tool, goal-round | Extra headers and series labelled change. **dsh-built-in**: installed header equality/series admission rules. |
| stream-chunking | intentional | 16 | todo-tool, goal-round | Engine buffers tool argument deltas. Only byte-identical joined argument records with the same identities/blocks/usage qualify. |
| assistant-tool-surface | bridge-gap | 1 | goal-round | First assistant surface lacks its second tool-call block, although both tools execute. **dsh-built-in**: commit complete assistant ContentBlocks before tool journaling. |
| stream-finish | bridge-gap | 6 | all 3 | Seven aligned assistant streams lose finish chunks; six raw fields belong primarily here because some whole-stream fields have another primary cause. **dsh-built-in**: preserve finish in `AssistantStreamAccumulator`. |
| goal-deferred-context | bridge-gap | 21 | goal-round | Three actual missing events: notice enqueue, next-step claim, closing user message. **dsh-built-in**: tools scheduler `additionalContexts`, stock accept-context callback and inbox delivery. |
| event-position | noise | 117 | all 3 | Matched events moved to another raw index. Event order itself is retained and described below. |
| sequence-reference | noise | 12 | all 3 | Numeric seq/reference/boundary offsets resolve to the same aligned event. |
| generated-identity | noise | 2 | goal-round | A later assistant's normalized generated id shifts after the missing closing notice; source references/revisions are checked separately. |

Every group in the generated report includes producer **and** consumer file/line citations with SHA256, scenario counts, sample pointers, full membership, explanation, effect and concrete route/owner for gaps. The durable JSON preserves that complete original group/member ledger.

## Evidence and delivery ownership

- **Factory identity:** `src/index.ts:265` registers `zcodeLoop` and the agents factory. Installed `@deepseek-ai/dsh-agent/lib/index.js:429` consumes `setFactory`. Compare actual `ready` and `complete` service **sets**, not each sorted position.
- **Inbox registration:** installed `@deepseek-ai/dsh-agent-loop/lib/index.js:26` defines the inbox fold and `:1583` registers it; installed `@deepseek-ai/dsh-session-projection/lib/index.js:126` reads state and `:138` exposes registered wire views. `src/inbox.ts:7` describes private folding and `src/index.ts:278` registers only turnBoundary. The existing projection framework owns this seam; a new plugin is unnecessary unless extraction is later chosen for reuse.
- **Request tools/context/header policy:** installed stock loop `lib/index.js:1217` builds the complete admitted header, `:1226` applies equality/series rules, and `:1264` builds context before `:1271` appends it. Installed session `lib/index.js:637` folds headers and `:1627` folds context. `src/bridges/event-store-bridge.ts:678` persists only route and writes every request as initial/change. All required host contracts already exist.
- **Stream chunking:** vendored engine `vendor/zcode/apps/zcode-cli/packages/core/src/runtime/methods/model.ts:184` buffers/flushes argument deltas and `:354` appends them to that buffer; bridge `src/bridges/event-store-bridge.ts:799` consumes the resulting deltas. This changes chunk boundaries, not joined argument bytes. The classifier coalesces only known clock-normalized tool argument record shapes and preserves unknown fields.
- **Missing stream finish:** `src/bridges/event-store-bridge.ts:825` sets `streamFinished` without pushing a finish chunk; `:947` consequently suppresses the fallback. Installed `@deepseek-ai/dsh-llm/lib/index.js:1000` consumes finish and `:1102` otherwise defaults to stop. The persisted terminal reason is an observed gap despite successful text/usage assertions.
- **Incomplete assistant tool surface:** `src/bridges/event-store-bridge.ts:985` flushes on the first scheduled call, while `:978` has already cleared the pending assistant after commit. In the goal fixture the second tool-call block is in the stock assistant at `/events/8/data/message/content/2`, absent from the ZCode assistant at `/events/7`; both aligned `tool/call` records still exist. Installed session `lib/index.js:1491` admits the durable surface consumers. This is not merely parallel scheduling noise.
- **Missing closing context:** installed `@deepseek-ai/dsh-tool-goal/lib/index.js:364` calls `exec.deferContext` for the goal completion notice. Installed `@deepseek-ai/dsh-tools/lib/index.js:3432` returns it as `additionalContexts`; installed stock loop `lib/index.js:572` accepts those contexts into its inbox. `src/bridges/tool-bridge.ts:178` calls tools.execute but reduces the result to text/error, dropping additionalContexts. The original stock events `/events/30`, `/events/32` and `/events/34` have no peers. This reuses dsh's existing deferred-context and next-step contracts; no missing host contract requires a new plugin.

## Alignment, primary assignment and limits

The original comparator remains positional and every raw difference is retained. Analysis pairs semantic events by type plus turn/step, call identity, goal operation, or scoped occurrence for inbox/user events. Header pairing includes its active turn/step. Field comparisons against those peers happen before positional attribution. A raw member receives exactly one primary root: an overlapping unknown wins; otherwise the first concrete semantic issue wins, followed by identity/reference noise, then event-position noise. When one positional comparison touches two different events, both peer pointers are retained and all aligned facts remain available separately. Root field counts therefore must not be interpreted as independent event counts.

A true missing event has no peer; a tail `turn/end` at another index still has a peer. Boundary and `sourceEventSeqs` noise requires resolution to the exact same paired event. Tool chunk coalescing must produce equal known records after removing a separately evidenced missing terminal finish; novel fields, changed content/source/revision, foreign registrations/projections and novel events remain unknown and fail classification. The tests include mutations under already shifted event arrays so nearby known differences cannot absorb them.

The raw order is still behavior: ZCode claims next-turn inbox before `turn/start` (`src/agent.ts:286`), whereas stock opens the turn before claim (`@deepseek-ai/dsh-agent-loop/lib/index.js:945`). ZCode publishes scheduled tool-call records before preceding results (`src/bridges/event-store-bridge.ts:985`); stock appends each call when starting it (`stock loop :578`). Positional-noise membership describes numeric comparison amplification, not equivalent scheduling, authority timing, or unrestricted safe reordering. Both complete raw captures and aligned facts remain inspectable.

The scripted goal adapter chooses its closing answer by request count (`scripts/contract-verification/fixture.ts:113`), so passing the fixture does not establish that the model received the missing closing instruction. New tests for later repairs must assert that actual request input and durable source, not only the resulting answer.

No original member establishes a rewind/checkpoint/rollback/memory gap or requires a new dsh plugin. Those broader capabilities remain outside these three fixtures. No runtime repair, production allowance, fixture change or equivalence approval is part of this classification stage.
