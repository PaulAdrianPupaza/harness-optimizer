/**
 * Token-budget policy for codegraph_explore (HP fork, F4).
 *
 * Upstream sizes explore by repo tier only and optimizes for latency/tool
 * calls, not tokens: in the TFG's level-2 pilot on vscode every explore filled
 * its ~24K-char ceiling and fresh (uncached) input rose 26% versus the no-index
 * agent. This module is the single place where the fork reshapes that budget,
 * so the upstream tier table (`getExploreOutputBudget`) stays untouched and
 * mergeable.
 *
 * `CODEGRAPH_EXPLORE_BUDGET_SCALE` (0.2–1; fork default 0.6, 1 = upstream) scales the
 * character ceilings uniformly, which keeps the tier invariant (a larger tier
 * never gets a smaller per-file cap than a smaller one). It exists to measure
 * the recall/token curve (bench/level1) before a default is chosen.
 */
import type { ExploreOutputBudget } from './tools';

const MIN_SCALE = 0.2;

/**
 * HP-fork default ceiling factor. Level-2 A/B (Sonnet, vscode + gin, 20 paired
 * sessions): 0.6 cut fresh input 13% (p=0.005) and cost 8% versus the full
 * upstream ceiling, with answer recall unchanged — the agent makes a few more
 * calls but each carries far less new context. `=1` restores upstream.
 */
export const DEFAULT_EXPLORE_BUDGET_SCALE = 0.6;

/**
 * Large-repo default (HP fork, F6): from this many indexed files up, the
 * ceiling factor is {@link LARGE_REPO_EXPLORE_BUDGET_SCALE}. Replaying the
 * explore queries of the 20 F5 agent sessions on vscode (bench/level1/
 * replay_level1.py), 0.5 returned 12% fewer tokens than 0.6 with identical
 * symbol/file recall and identical body coverage on every task, once
 * `reserveNamedBodies` protects what the query named; 0.4 starts losing named
 * bodies. On gin (110 files, already on the 13K tier) 0.5 loses a named body,
 * so small repos keep 0.6.
 */
export const LARGE_REPO_FILE_COUNT = 5000;
export const LARGE_REPO_EXPLORE_BUDGET_SCALE = 0.5;

export function exploreBudgetScale(env: NodeJS.ProcessEnv = process.env, fileCount?: number): number {
  const fallback = fileCount !== undefined && fileCount >= LARGE_REPO_FILE_COUNT && env.CODEGRAPH_EXPLORE_LARGE_REPO_SCALE !== '0'
    ? LARGE_REPO_EXPLORE_BUDGET_SCALE
    : DEFAULT_EXPLORE_BUDGET_SCALE;
  const raw = env.CODEGRAPH_EXPLORE_BUDGET_SCALE;
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(MIN_SCALE, v));
}

export function applyExploreBudgetPolicy(
  budget: ExploreOutputBudget,
  env: NodeJS.ProcessEnv = process.env,
  opts: { exactTargets?: boolean; lineAnchors?: boolean; fileCount?: number } = {},
): ExploreOutputBudget {
  // A qualified name / line anchor is a request for a whole body: keep the
  // upstream ceiling for it (upstream's explore-exact-target contract).
  // F6 measured dropping the exemption for qualified names now that
  // `reserveNamedBodies` reserves the exact body first: 17% fewer tokens on
  // gin, but 4 of the 40 replayed F5 sessions lost body coverage (vscode-05's
  // `FileService.writeFile` 65% -> 23%), so it stays opt-in:
  // `CODEGRAPH_EXPLORE_EXACT_SCALED=1` scales qualified-name calls too.
  const scaleExact = env.CODEGRAPH_EXPLORE_EXACT_SCALED === '1' && namedBodiesEnabled(env) && opts.lineAnchors === false;
  if (opts.exactTargets && !scaleExact) return budget;
  const scale = exploreBudgetScale(env, opts.fileCount);
  if (scale === 1) return budget;
  return {
    ...budget,
    maxOutputChars: Math.round(budget.maxOutputChars * scale),
    // `CODEGRAPH_EXPLORE_BUDGET_PERFILE=0` scales only the total ceiling: fewer
    // files, each as complete as before, instead of thinner windows everywhere.
    maxCharsPerFile: env.CODEGRAPH_EXPLORE_BUDGET_PERFILE === '0'
      ? budget.maxCharsPerFile
      : Math.round(budget.maxCharsPerFile * scale),
  };
}

/**
 * Render PERIPHERAL files (no spine node, nothing named, no entry point) as a
 * signature skeleton instead of source windows. `CODEGRAPH_EXPLORE_PERIPHERAL_SKELETON`
 * = `1` enables it (default off until measured).
 */
export function explorePeripheralSkeletonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEGRAPH_EXPLORE_PERIPHERAL_SKELETON;
  return raw === '1' || raw === 'true';
}

/** Most informative relationship kinds first; anything unlisted keeps its order after them. */
const KIND_ORDER = ['calls', 'implements', 'extends', 'overrides', 'instantiates', 'returns', 'type_of', 'decorates', 'references'];
const REFERENCES_CAP = 5;

/**
 * Compact explore's Relationships map (HP fork, F4). The map lists edges by
 * symbol NAME, so overloads/constructors collapse into byte-identical lines
 * ("constructor → Host" ×4 on vscode) and self-pairs; `references` — the
 * noisiest kind — got the same per-kind allowance as `calls`. On by default
 * (`CODEGRAPH_EXPLORE_COMPACT_META=0` restores upstream): dedup is lossless,
 * the references cap is the only lossy part.
 */
export function compactRelationshipsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEGRAPH_EXPLORE_COMPACT_META;
  return raw !== '0' && raw !== 'false';
}

export function compactRelationships(
  byKind: Map<string, Array<{ source: string; target: string }>>,
  perKindCap: number,
): Array<{ kind: string; edges: Array<{ source: string; target: string }>; total: number }> {
  const kinds = [...byKind.keys()].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a), ib = KIND_ORDER.indexOf(b);
    return (ia < 0 ? KIND_ORDER.length : ia) - (ib < 0 ? KIND_ORDER.length : ib);
  });
  return kinds.map((kind) => {
    const seen = new Set<string>();
    const unique = byKind.get(kind)!.filter((e) => {
      if (e.source === e.target) return false;
      const key = `${e.source} -> ${e.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const cap = kind === 'references' ? Math.min(perKindCap, REFERENCES_CAP) : perKindCap;
    return { kind, edges: unique.slice(0, cap), total: unique.length };
  }).filter((g) => g.total > 0);
}

/**
 * Quality-adaptive ceiling (HP fork, F4). Once explore has found a real call
 * path among the symbols the query named (>= 2 spine nodes), that path IS the
 * answer and the rest of the envelope is supporting context, so the ceiling
 * can shrink. `CODEGRAPH_EXPLORE_ADAPTIVE_FLOW` = the factor applied (0.2–1;
 * unset/1 = off). Applied after the flow is computed, before allocation.
 */
export function adaptBudgetToFlow(
  budget: ExploreOutputBudget,
  spineSize: number,
  env: NodeJS.ProcessEnv = process.env,
): ExploreOutputBudget {
  const raw = env.CODEGRAPH_EXPLORE_ADAPTIVE_FLOW;
  if (raw === undefined || raw.trim() === '' || spineSize < 2) return budget;
  const v = Number(raw);
  if (!Number.isFinite(v) || v >= 1) return budget;
  const f = Math.max(MIN_SCALE, v);
  return { ...budget, maxOutputChars: Math.round(budget.maxOutputChars * f) };
}

// ── F6 (HP fork): spend the envelope on what the query asked for ─────────────
//
// Diagnosis on the 120 F5 agent sessions (knowledge-base/F6-mejoras): after an
// explore, 38 of 56 follow-up Reads hit a file explore HAD shown, and 42% of the
// lines they read sat inside an elided gap of that file — typically the body of
// a callable the query named (gin `handleHTTPRequest`, vscode
// `FileService.writeFile`). Meanwhile 37% of a vscode response was not source:
// a Relationships map over the whole gathered subgraph, file headers listing
// edge lines as if they were symbols (`calls(calls)`), caller-file lists.
// Three independent switches, each default ON and each `=0` to restore hp-tfg:
//
//   CODEGRAPH_EXPLORE_NAMED_BODIES  reserve each file the room its NAMED callables need
//   CODEGRAPH_EXPLORE_FOCUS_META    relationships/headers/blast radius about the question only
//   CODEGRAPH_EXPLORE_STRIP_CR      drop the `\r` of CRLF checkouts from rendered source

function switchOn(raw: string | undefined): boolean {
  return raw !== '0' && raw !== 'false';
}

export function namedBodiesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_NAMED_BODIES);
}

/** Named-class files earn the named-first tier; uncorroborated overload guesses do not (F6). */
export function namedTypesTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_NAMED_TYPES);
}

/**
 * F7 switches (each default on, `=0` restores hp-tfg-v2). Evidence:
 * knowledge-base/F7/00-diagnostico-reads.md — the Reads left after explore in
 * the F6 level-2 sessions.
 *   CODEGRAPH_EXPLORE_LOWER_TYPES  camelCase tokens naming a type are type tokens (Go `jsonBinding`)
 *   CODEGRAPH_EXPLORE_NAMED_CTORS  the constructor of a named class is a named callable
 *   CODEGRAPH_EXPLORE_NAMED_WHOLE  a named callable's cluster may run to the spine ceiling
 */
export function lowerTypesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_LOWER_TYPES);
}

export function namedCtorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_NAMED_CTORS);
}

export function namedWholeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_NAMED_WHOLE);
}

export function focusMetaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_FOCUS_META);
}

export function stripCarriageReturnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchOn(env.CODEGRAPH_EXPLORE_STRIP_CR);
}

/**
 * Longest named body a reservation is raised for, in rendered chars (~150
 * lines). Past it the render loop's own windowing (signature head + call
 * site) is the right answer; reserving a god-method whole would starve every
 * other file, which is the failure the proportional split exists to prevent.
 */
export const NAMED_BODY_MAX_CHARS = 6000;

/**
 * Re-split the allocator's reservations so every file can hold the bodies of
 * the callables the query NAMED in it.
 *
 * `allowances` is what `allocateExploreBudget` reserved (path → chars), in rank
 * order; `needs` is, per file, the rendered size of its named callable bodies
 * (already capped per body by the caller). A file reserved less than it needs
 * is topped up from the files reserved MORE than they need, in proportion to
 * their surplus and never below `minChars`. The total is conserved exactly, so
 * the response is no larger than before — the same bytes move from files that
 * merely ranked to the lines the agent asked for by name.
 *
 * When the surplus cannot cover every shortfall, shortfalls are served
 * pro rata. Files not in `allowances` (cliffed, past maxFiles) are never
 * admitted here: admission stays the allocator's decision.
 */
export function reserveNamedBodies(
  allowances: ReadonlyMap<string, number>,
  needs: ReadonlyMap<string, number>,
  minChars: number,
): Map<string, number> {
  const out = new Map(allowances);
  let shortfall = 0;
  let surplus = 0;
  const short = new Map<string, number>();
  const spare = new Map<string, number>();
  for (const [path, reserved] of allowances) {
    const need = Math.max(0, Math.floor(needs.get(path) ?? 0));
    if (need > reserved) {
      short.set(path, need - reserved);
      shortfall += need - reserved;
    } else {
      const s = Math.max(0, reserved - Math.max(need, minChars));
      if (s > 0) { spare.set(path, s); surplus += s; }
    }
  }
  if (shortfall <= 0 || surplus <= 0) return out;
  const moved = Math.min(shortfall, surplus);
  let taken = 0;
  for (const [path, s] of spare) {
    const t = Math.floor((moved * s) / surplus);
    out.set(path, (out.get(path) ?? 0) - t);
    taken += t;
  }
  // Hand out exactly what was taken (flooring both sides keeps the sum <= before).
  let given = 0;
  const shortPaths = [...short.keys()];
  shortPaths.forEach((path, i) => {
    const g = i === shortPaths.length - 1
      ? taken - given
      : Math.floor((taken * short.get(path)!) / shortfall);
    out.set(path, (out.get(path) ?? 0) + g);
    given += g;
  });
  return out;
}

/**
 * Relationship edges worth their bytes: those with an endpoint the question is
 * about (a named symbol, an exact target, the flow spine). The map used to
 * cover the whole gathered subgraph, so on vscode it listed `layoutPreview →
 * fromString` under a question about saving a file. Falls back to every edge
 * when the question resolved to no symbol at all (a pure natural-language
 * query), where the map is the only structure the response carries.
 */
export function focusRelationshipEdges<E extends { source: string; target: string }>(
  edges: readonly E[],
  questionIds: ReadonlySet<string>,
): E[] {
  if (questionIds.size === 0) return [...edges];
  const focused = edges.filter((e) => questionIds.has(e.source) || questionIds.has(e.target));
  return focused.length > 0 ? focused : [...edges];
}

const EDGE_KIND_LABEL = /\((calls|references|imports|exports|instantiates|extends|implements|overrides|decorates|type_of|returns|contains|navigates)\)$/;

/**
 * File-header symbols that are DEFINITIONS. A cluster's symbol list also
 * carries one entry per outgoing edge line, labelled `target(edgeKind)` — or
 * `calls(calls)` when the target is outside the gathered subgraph — and the
 * header ranks by frequency, so those led it: vscode headers opened with
 * `calls(calls), references(references), imports(imports)` and averaged 1.7K
 * chars per response. Returns the input untouched if nothing else is left.
 */
export function definitionHeaderSymbols(symbols: readonly string[]): string[] {
  const defs = symbols.filter((s) => !EDGE_KIND_LABEL.test(s));
  return defs.length > 0 ? defs : [...symbols];
}

/** `definitionHeaderSymbols` for refs that carry their kind as a field (the elided-symbol list). */
export function definitionRefs<T extends { kind: string }>(refs: readonly T[]): T[] {
  return refs.filter((r) => !EDGE_KIND_LABEL.test(`(${r.kind})`));
}

/** Caller / test files listed per blast-radius entry (hp-tfg: 4 and 4). */
export function blastRadiusFileCaps(env: NodeJS.ProcessEnv = process.env): { callers: number; tests: number } {
  return focusMetaEnabled(env) ? { callers: 2, tests: 1 } : { callers: 4, tests: 4 };
}

/**
 * Source lines of a file as explore renders them. A CRLF checkout (the
 * default on Windows) kept its `\r` on every rendered line: 1.4–2.1% of the
 * response's chars and ~4% of its tokens, for a byte the agent cannot see and
 * `Edit` does not need. Fingerprints and drift checks keep reading the raw
 * bytes; only the rendered text is normalised.
 */
export function stripCarriageReturns(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return stripCarriageReturnEnabled(env) && text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}
