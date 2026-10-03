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

## Building on Windows

```bash
. ../env.sh                     # Node 22 (node:sqlite) on PATH
npm ci && npm run build
bash scripts/build-kernel.sh    # Rust kernel → codegraph-kernel/prebuilds/win32-x64/
```
