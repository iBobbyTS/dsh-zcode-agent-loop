# Current contract status and historical evidence

`pnpm verify:contracts` is the actionable current gate: it runs each stock/ZCode capture once, validates the installed pinned authority, classifies exact semantic peers, and writes standalone HTML/Markdown plus full raw values. The 2026-10-17 current capture has **292 raw differences, 7 groups, 134 intentional, 158 noise, 0 bridge-gap, 0 unknown**. Its bounded semantic result is **PASS**, while the unchanged raw matrix remains **FAIL** with zero allowances and coverage remains **partial**. Future runs compute their own counts.

```sh
pnpm verify:contracts
pnpm verify:contracts --out /tmp/current-contract-status
pnpm verify:contracts --strict-coverage
pnpm verify:classify:selftest
pnpm verify:contracts:status-selftest
pnpm typecheck
```

The default deliverable is `.agent-work/tmp/contract-classification/report/index.html`. Companion files are `report.md`, `classification.json`, `raw-differences.json`, `check.json`, `matrix/report.json` (complete fresh captures) and `original/` (all historical groups, source citations and 289 raw members). No report build or network dependency is needed. Content is escaped. `verify:classify --input PATH --out DIR` remains available for inspecting saved captures; it does not run scenarios or certify coverage.

The combined command exits **0** only for all three valid executed scenarios and no detected real/unknown semantic gap; **1** for capture/fixture failure, authority mismatch, known gap, unknown or invalid input; **2** when those semantic checks pass but `--strict-coverage` rejects partial coverage. A failure replaces the current HTML with an explicit failure report. The classifier alone also exits 1 for known gaps or unknowns. Raw differences are recomputed, stale lists rejected, and no production allowance is added.

## Current repairs, separately from original membership

All seven original gap roots use existing dsh host contracts. No new host plugin was required. Tests below assert real consumer behavior; recorded browser checks were accepted by the parent in each stage, not rerun by the report generator.

| Original gap root | Code commit | Meaningful test | Bounded prior browser evidence |
| --- | --- | --- | --- |
| inbox-projection | `95f56d9` | `scripts/inbox-projection-integration.ts`: public registry/state/wire, invalid history, JSONL cold resume, exactly-once consumption | Queue B while A streams, refresh, two ordered turns; original sources and one insertion correlated via JSONL. `.agent-work/tmp/inbox-projection/browser-summary.json`. |
| request-tools | `60cf2fa` | `scripts/request-provenance-integration.ts`: actual prepared dispatch equals persisted admitted tool/config snapshot before response | Standard glm-5.3-flash Request view and JSONL: 31 tools, actual route/options. `.agent-work/tmp/request-provenance-browser-summary.json`. |
| request-context | `60cf2fa` | Same test: effective context/defaults, omission, both streaming paths, replay | Same browser session: context usage and contextWindow 1000000 correlated. |
| request-header-policy | `60cf2fa` | Same test: equality, change/series/resume, additions/removals, rejection/accepted turn number and stock comparison | Same session: 2 requests with one initial header. |
| assistant-tool-surface | `bded5a4` | `scripts/tool-surface-context-integration.ts`: complete paired calls before journals, during-stream/nonstream and replay | Paired goal/todo cards followed assistant without orphan rows. `.agent-work/tmp/tool-fidelity-browser.txt`. |
| stream-finish | `bded5a4` | Same test: installed BlockAssembler, one stop/tool-calls/length finish, usage/live/end sequence | Same browser flow finished 2 turns / 5 steps; terminal reason is established by focused consumer tests. |
| goal-deferred-context | `bded5a4` | Same test plus `scripts/goal-chain-integration.ts`: original notice/source in actual following request, success/error/owner isolation | Automatic goal round, completion notice after result, Request 5 GOAL_WRAPUP_VERIFIED. Same browser evidence. |

Parent acceptance records are `.agent-work/archive/20261017-1259_inbox-projection/PLAN.md`, `20261017-1253_request-provenance/PLAN.md`, and `20261017-1244_tool-surface-context/PLAN.md`. The generated report includes these paths and evidence summaries for each root. Absence of a current classified gap is bounded to executed scenarios; it does not replace those consumer regressions.

An additional live-preset issue, **agent-scoped tool visibility**, was discovered outside the original289 membership. Commit `32c231a` resolves explicit agent scope for schemas/metadata and refreshes the existing engine tool cache. `scripts/preset-tools-integration.ts` checks first request, real handler/initiator, global controls, sibling isolation and add/remove across turns. Parent browser acceptance saw goal/todo operations complete and TOOL_CHAIN_SCOPE_OK; screenshot `.agent-work/tmp/contract-classification/browser-tool-scope-after.png`, record `.agent-work/archive/20261017-1237_preset-tool-scope/PLAN.md`. This does not add historical members.

## Narrow newly exposed rules

**mock-token-budget (intentional):** only stock config exactly `{model: "mock", provider: "mock"}` versus that exact config plus ZCode `maxTokens: 32000` qualifies. The existing engine default is produced at `vendor/zcode/apps/zcode-cli/packages/core/src/runtime/methods/model-token-limits.ts:5`; `src/bridges/model-bridge.ts:415` maps it to the provider request, and the prepared-request hook persists it. Another budget, route or unknown config field remains unknown. The cap difference remains visible; budgets are not changed to make the report green.

**header-tool-order (noise):** only request/header tool arrays with unique string names and identical complete schemas by name qualify. `src/bridges/tool-bridge.ts:151` enumerates the owner-scoped tools, the engine admits its order, and `src/bridges/event-store-bridge.ts:723` persists the actual admitted request. Current source file/line/hash anchors for both new rules are emitted at report time. Changed/extra fields, duplicate names, missing tools and schema changes remain unknown even under existing positional differences. No tool order is changed by classification.

Unknown semantic fields always win over positional explanations. The status selftest mutates these actual current captures, removes context/projection/multi-tool/finish/deferred notice, verifies unknowns survive order changes, and checks one collector call, capture/authority failure and strict exit behavior. Original negative tests remain active.

## Coverage limits

The shared mock fixture exercises only basic-text, todo-tool and goal-round. Unexercised profile families and static obligations remain partial; no report PASS means full engine or full profile parity. Claimed-turn admission is not complete per-model-step host middleware parity. Synchronization of externally compacted/replaced host history into the embedded engine, broad compact/side paths, rewind/checkpoint/rollback/memory and other deployed plugin families remain unproved.

## Historical authority and immutability

The [original ledger](CONTRACT-ORIGINAL-289.json) remains byte-identical: **289 raw members, 13 roots, 67 intentional, 131 noise, 91 bridge-gap, 0 unknown**. Ledger SHA256 is `cf4aa78fb0cb00c95f0743c1a57aa0fc9179fdc8a4ff962478839efbd394c63b`; baseline full-capture SHA256 is `2b28b0ee92eb772f30a24c4012b25655df30d5ed1ebb7e88de25fefa5e5d3fac`, from baseline commit `1a3bd84`. Member hashes, original file/line/source-hash triples and categories are historical evidence, not current unresolved-gap counts. A deterministic compressed mock capture is retained at `scripts/contract-verification/fixtures/original-289.json.gz` for reproducible original membership and negative selftests.

Authority is installed `@deepseek-ai/dsh@0.2.1-alpha.5`, its same-version loop and installed session/LLM/tool/projection consumers, never `reference/`. New current rules cite current sources; original citations stay attached to saved historical hashes. `--ledger NEW_PATH` still creates a separate ledger exclusively and refuses an existing path.

## Historical original 289 ledger

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

All file/line references below describe the historical baseline **1a3bd84**, with the saved per-file SHA256 in each original ledger root. They are not current repaired file locations. The classifier reuses those saved triples without hashing repaired source against old line numbers.

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

No original member establishes a rewind/checkpoint/rollback/memory gap or requires a new dsh plugin. Those broader capabilities remain outside these three fixtures. The original classification stage made no runtime repair or allowance changes; later repair evidence is recorded above.
