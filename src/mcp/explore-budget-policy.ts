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
 * `CODEGRAPH_EXPLORE_BUDGET_SCALE` (0.2–1, default 1 = upstream) scales the
 * character ceilings uniformly, which keeps the tier invariant (a larger tier
 * never gets a smaller per-file cap than a smaller one). It exists to measure
 * the recall/token curve (bench/level1) before a default is chosen.
 */
import type { ExploreOutputBudget } from './tools';

const MIN_SCALE = 0.2;

export function exploreBudgetScale(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEGRAPH_EXPLORE_BUDGET_SCALE;
  if (raw === undefined || raw.trim() === '') return 1;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(MIN_SCALE, v));
}

export function applyExploreBudgetPolicy(budget: ExploreOutputBudget, env: NodeJS.ProcessEnv = process.env): ExploreOutputBudget {
  const scale = exploreBudgetScale(env);
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
