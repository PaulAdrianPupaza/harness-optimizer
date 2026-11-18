# Fork notes — `hp-tfg`

Fork of [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) (MIT) for the
La Salle × HP final-degree project *Code Intelligence for AI Agents* (Challenge 1).
Base: upstream `6560052` (v1.6.2). Remote `upstream` tracks the original; keep the diff small
and modular so upstream changes can keep being merged in.

The project's research notes, benchmark harness and results live outside this repo, in the
parent `harness-optimizer/` workspace (`knowledge-base/`, `bench/`, `results/`).

## Divergences from upstream

| Change | Why | Files | Tests |
|---|---|---|---|
| `indexAll` / `sync` report the **whole-run** `durationMs` (it used to stop at the end of extraction) | On vscode (4M LOC) a 25-minute index was reported as "1m 23s": resolution + synthesis are ~90% of the run on large repos | `src/index.ts` | `__tests__/index-duration.test.ts` |
| `CODEGRAPH_SYNTH_TIMINGS` charges synthesis pass time to a new `passes-wall` line instead of `dedupe-merge` | `dedupe-merge` showed 184 s on vscode (and 119 s in a 10-file sync) for a sub-second merge: the step clock never moved while passes ran | `src/resolution/callback-synthesizer.ts` | `__tests__/synth-timing-attribution.test.ts` |
| Telemetry **off by default** (`DEFAULT_TELEMETRY_ENABLED = false`; installer toggle defaults to off) | Indexing proprietary HP code must never phone home without an explicit opt-in | `src/telemetry/index.ts`, `src/installer/index.ts`, `TELEMETRY.md` | `__tests__/telemetry.test.ts` (*HP fork default*) |

### F3 — retrieval at scale

| Change | Why | Files | Tests |
|---|---|---|---|
| Query tokenizer recognizes acronym-led (`RPCProtocol`) and `_`/`$`-prefixed (`_receiveOne`, `$executeCommand`) identifiers; the prefix trim and an entry-point reservation keep named identifiers in the result | On vscode the named `RPCProtocol` was never looked up and prose words filled every slot; level-1 vscode recall 0.55/0.32 → 0.58/0.47 (symbols/files) | `src/context/index.ts` | `__tests__/named-identifier-seeding.test.ts` |
| `rpcProxyEdges` synthesis pass: unresolved `proxy.$method(…)` calls → the 1–4 class methods named `$method` | VS Code's extension-host ↔ main-thread RPC dead-ended the flow; +1,600 edges on vscode | `src/resolution/rpc-proxy-synthesizer.ts`, `src/resolution/callback-synthesizer.ts`, `src/db/queries.ts` | `__tests__/rpc-proxy-synthesizer.test.ts` |

### F4 — token budget (`src/mcp/explore-budget-policy.ts`)

| Change | Default | Evidence |
|---|---|---|
| Output ceiling × `CODEGRAPH_EXPLORE_BUDGET_SCALE` | **0.6** (`1` = upstream); calls with exact targets keep the upstream ceiling | Level-2 A/B (Sonnet, 20 paired sessions): −13% fresh input (p=0.005), −8% cost vs full ceiling, recall unchanged |
| Compact Relationships map (dedup name pairs, drop self pairs, cap `references` at 5) | on (`CODEGRAPH_EXPLORE_COMPACT_META=0` = upstream) | Same ceiling, more source |
| Quality-adaptive ceiling once a flow spine is found (`CODEGRAPH_EXPLORE_ADAPTIVE_FLOW`) | off | Level-1: 0.6 → −14% tokens on gin, no recall loss |
| Peripheral-file skeleton (`CODEGRAPH_EXPLORE_PERIPHERAL_SKELETON`) | off | No effect on the benchmark |

Tests: `__tests__/explore-budget-policy.test.ts`. The upstream allocation suites pin
`CODEGRAPH_EXPLORE_BUDGET_SCALE=1` in `__tests__/setup-home-sandbox.ts` (their fixtures are sized
to the upstream ceilings).

### F6 — spend the envelope on what the query asked for (branch `hp-tfg-v2`)

Evidence: replay of the 52 explore queries real agents wrote in the F5 sessions
(`bench/level1/replay_level1.py` in the outer repo), 40 paired sessions, gin + vscode. Each
switch is default ON and `=0` restores `hp-tfg`.

| Change | Switch | Files |
|---|---|---|
| Re-split the allocator's reservations so a file can hold the bodies of the callables the query named (tiers: exact + spine, unique names, all named defs); named callables outrank plain search roots inside a file | `CODEGRAPH_EXPLORE_NAMED_BODIES` | `src/mcp/explore-budget-policy.ts` (`reserveNamedBodies`), `src/mcp/tools.ts` |
| Relationships limited to edges touching the question's symbols; file headers list definitions, not edge lines; blast radius lists 2 caller files + 1 test file | `CODEGRAPH_EXPLORE_FOCUS_META` | same |
| Files defining a class/struct the query named earn the named-first tier; an uncorroborated guess among > 3 namesakes no longer does | `CODEGRAPH_EXPLORE_NAMED_TYPES` | `src/mcp/tools.ts` |
| Ceiling factor 0.5 (instead of 0.6) from 5,000 indexed files | `CODEGRAPH_EXPLORE_LARGE_REPO_SCALE` | `src/mcp/explore-budget-policy.ts` |
| Rendered source drops the `
` of CRLF checkouts | `CODEGRAPH_EXPLORE_STRIP_CR` | same |
| Compact `initialize` instructions (714 vs 1,512 tokens) | `CODEGRAPH_COMPACT_INSTRUCTIONS` | `src/mcp/server-instructions.ts` |
| Opt-in: scale the ceiling for qualified-name calls too | `CODEGRAPH_EXPLORE_EXACT_SCALED=1` | `src/mcp/explore-budget-policy.ts` |

Tests: `__tests__/explore-budget-policy.test.ts`, `__tests__/explore-named-bodies.test.ts`;
`__tests__/explore-named-file-valve.test.ts` runs its saturated-response suite with
`CODEGRAPH_EXPLORE_NAMED_BODIES=0` (it pins the hp-tfg allocation shape).

### F7 — anticipate the Reads agents still made after explore (branch `hp-tfg-v3`)

Evidence: the Reads made after `codegraph_explore` in the 80 F6 level-2 sessions, replayed
(`bench/level1/replay_level1.py --queries bench/tasks/replay_queries_f6.json` in the outer repo).
vs `hp-tfg-v2`: GT body coverage +5.2% (p=0.007), lines the agent later Read already shown
237 → 576 of 2,421, symbol/file recall unchanged in 80/80, tokens +0.6%.
Level 2 (60 agent sessions, v3 vs v2): no measurable difference (cost +2% p=0.75, or −4% p=0.31
without two cold-prompt-cache pairs; Reads not reduced), so F7 is not claimed as a token saving.

| Change | Switch | Default |
|---|---|---|
| A camelCase token that names a type exactly is a type token (Go's unexported `jsonBinding`); a token no longer counts as its own context; a named class the query singles out (it does not name 3+ distinct classes sharing one of its supertypes) is spared the polymorphic-sibling skeleton | `CODEGRAPH_EXPLORE_LOWER_TYPES` | on (`=0` = hp-tfg-v2) |
| The constructor of a named class joins the named-body reservation when no method of the class is named and it calls something the query named | `CODEGRAPH_EXPLORE_NAMED_CTORS` | opt-in (`=1`): no measured effect |
| A named callable's cluster may exceed the per-file budget by what its named bodies need | `CODEGRAPH_EXPLORE_NAMED_WHOLE` | opt-in (`=1`): no measured effect |

Tests: `__tests__/explore-f7-named-types.test.ts`, `__tests__/explore-budget-policy.test.ts`.

## Building on Windows

```bash
. ../env.sh                     # Node 22 (node:sqlite) on PATH
npm ci && npm run build
bash scripts/build-kernel.sh    # Rust kernel → codegraph-kernel/prebuilds/win32-x64/
```
