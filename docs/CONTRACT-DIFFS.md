# Installed stock contract differential

`pnpm verify:matrix` improves a declaration-only capability audit by running the installed npm stock agent-loop and the ZCode loop against the same mock fixture. Each side starts in a separate child process and fresh Cordis Context; only the loop plugin changes. The authority is `@deepseek-ai/dsh@0.2.1-alpha.5` and its installed same-version loop, never `reference/`.

The initial fixtures execute basic text, `todo_write`, and goal creation → automatic round → completion. Both sides must assert request counts, durable source, actual todo writes, goal round prompt, complete goal state, and absence of `GOAL_TOOL_*` authority rejection where applicable. Assembly, activation, assertion, cleanup, missing oracle and timeout errors are execution failures. A child process has a 30-second hard deadline, including cleanup.

```sh
pnpm verify:matrix
pnpm verify:matrix --out /tmp/dsh-contract-report
pnpm verify:matrix --strict-coverage
pnpm verify:contracts:selftest
```

`report.json` and a readable `evidence.md` matrix are written to the output directory (default `.agent-work/tmp/contract-verification`). Existing manual documentation is never rewritten. Exit 0 means valid initial scenarios with no unallowed differences; exit 1 means a differential or infrastructure failure; exit 2 means execution passed but strict coverage rejected remaining gaps. Execution and coverage are independent: partial coverage alone is allowed by the default command. The initial matrix currently reports **FAIL** for observed event/projection/registration differences; successful fixture assertions do not imply oracle equivalence.

Each report contains package versions and hashes, shipped profile patch hashes and expanded rows, runtime registration keys at readiness and completion, full normalized events in original order, every registered projection's final state, structural differences with both values, separate missing/extra registration keys, source inventory, family matrix, and counts. Fields and events are never filtered out before comparison. Thus insertion or ordering differences can produce many positional differences. In particular the observed stock `inbox` projection, differing loop service names, inbox event order, request/context events and stream structures remain visible failures, pending review and policy decisions.

Normalization only maps generated UUID identities belonging to messages/goals, retaining equal and unequal references, including references embedded in textual tool results. Fixed fixture call IDs stay literal. Only explicit session-event times, stream times/delta arrays, and goal create/update timestamps at known contract locations are clock values. Source, revisions, rounds, event sequences, unknown fields and error content survive. Normalization does not reorder events or approve semantic differences.

The allowance validator requires a scenario, exact JSON pointer, difference kind, both exact values, nonempty rationale and source citation. Wildcard pointers and wildcard scenarios are rejected, and unused entries are surfaced as stale. The production allowance list starts empty: unknown differences remain failures. Future allowances must be backed by existing intentional design evidence and reviewed alongside the named scenario, rather than generated from a failing run.

To add a scenario, extend the single adapter/driver in `scripts/contract-verification/fixture.ts`, add its name in the runner, and add assertions that prove the claimed consumer actually ran in both loops. Update the explicit evidence-to-family associations only for those consumers. A loaded plugin or profile row does not prove it was triggered. Extend the clock/identity normalizer only for documented field semantics and add negative preservation tests.

For an upgrade, install and pin the intended npm version, deliberately update the runner's version guard, rerun the matrix and selftests, and compare package/source/profile hashes and call-site fingerprints. New or changed inventory calls remain unknown until explicit evidence or an intentional-difference rationale is attached; line moves do not by themselves change fingerprints. Review every unallowed or stale difference. Do not copy old green statuses onto new fingerprints.

The negative selftest consumes actual matrix captures, exercises an actual plugin activation with `turnBoundary` registration suppressed, and mutates captured source, goal error content, unknown fields, events and projections. It also checks reference/revision preservation, allowance precision/staleness, new source obligations, new profile families and strict coverage exit policy, then reruns all six runtime/scenario combinations to verify deterministic normalized captures. Run the matrix first; it may legitimately exit 1 while still producing valid captures for selftests.

The [root-cause classifier](CONTRACT-ROOT-CAUSES.md) now assigns the original 289 raw differences to source-evidenced groups without changing allowances. Run `pnpm verify:classify` on the current matrix report, or pass `--input PATH --out DIR`. It emits standalone HTML, Markdown, full JSON membership and a separate raw-difference file. `pnpm verify:classify:selftest` exercises exact membership, semantic mutations, registration sets and output escaping. The durable [original ledger](CONTRACT-ORIGINAL-289.json) remains separate from later captures.
