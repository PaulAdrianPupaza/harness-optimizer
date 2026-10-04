import { describe, expect, it } from 'vitest';
import {
  adaptBudgetToFlow,
  applyExploreBudgetPolicy,
  compactRelationships,
  compactRelationshipsEnabled,
  exploreBudgetScale,
  explorePeripheralSkeletonEnabled,
} from '../src/mcp/explore-budget-policy';
import { getExploreOutputBudget } from '../src/mcp/tools';

describe('explore budget policy (HP fork, F4)', () => {
  it('leaves the upstream tier budget untouched by default', () => {
    const tier = getExploreOutputBudget(10_000);
    expect(applyExploreBudgetPolicy(tier, {})).toEqual(tier);
    expect(exploreBudgetScale({})).toBe(1);
  });

  it('scales the ceilings and clamps the factor to [0.2, 1]', () => {
    const tier = getExploreOutputBudget(10_000);
    const half = applyExploreBudgetPolicy(tier, { CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.5' });
    expect(half.maxOutputChars).toBe(Math.round(tier.maxOutputChars / 2));
    expect(half.maxCharsPerFile).toBe(Math.round(tier.maxCharsPerFile / 2));
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.01' })).toBe(0.2);
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: '3' })).toBe(1);
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: 'abc' })).toBe(1);
    const ceilingOnly = applyExploreBudgetPolicy(tier, { CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.5', CODEGRAPH_EXPLORE_BUDGET_PERFILE: '0' });
    expect(ceilingOnly.maxCharsPerFile).toBe(tier.maxCharsPerFile);
  });

  it('keeps the tier invariant (larger tier never gets a smaller per-file cap) under scaling', () => {
    const env = { CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.6' };
    const caps = [100, 300, 1_000, 10_000, 50_000].map((n) => applyExploreBudgetPolicy(getExploreOutputBudget(n), env).maxCharsPerFile);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]!);
  });

  it('compacts relationships: dedups name pairs, drops self pairs, caps references, orders kinds', () => {
    const byKind = new Map([
      ['references', Array.from({ length: 9 }, (_, i) => ({ source: 'constructor', target: `T${i}` }))],
      ['calls', [
        { source: 'a', target: 'b' }, { source: 'a', target: 'b' }, { source: 'x', target: 'x' }, { source: 'b', target: 'c' },
      ]],
    ]);
    const out = compactRelationships(byKind, 15);
    expect(out.map((g) => g.kind)).toEqual(['calls', 'references']);
    expect(out[0]!.edges).toEqual([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]);
    expect(out[1]!.edges).toHaveLength(5);
    expect(out[1]!.total).toBe(9);
  });

  it('switches: compact meta on by default, peripheral skeleton off by default', () => {
    expect(compactRelationshipsEnabled({})).toBe(true);
    expect(compactRelationshipsEnabled({ CODEGRAPH_EXPLORE_COMPACT_META: '0' })).toBe(false);
    expect(explorePeripheralSkeletonEnabled({})).toBe(false);
    expect(explorePeripheralSkeletonEnabled({ CODEGRAPH_EXPLORE_PERIPHERAL_SKELETON: '1' })).toBe(true);
  });

  it('adaptive flow ceiling: shrinks only with a real spine and an explicit factor', () => {
    const tier = getExploreOutputBudget(10_000);
    expect(adaptBudgetToFlow(tier, 5, {})).toEqual(tier);
    expect(adaptBudgetToFlow(tier, 1, { CODEGRAPH_EXPLORE_ADAPTIVE_FLOW: '0.6' })).toEqual(tier);
    const shrunk = adaptBudgetToFlow(tier, 3, { CODEGRAPH_EXPLORE_ADAPTIVE_FLOW: '0.6' });
    expect(shrunk.maxOutputChars).toBe(Math.round(tier.maxOutputChars * 0.6));
    expect(shrunk.maxCharsPerFile).toBe(tier.maxCharsPerFile);
    expect(adaptBudgetToFlow(tier, 3, { CODEGRAPH_EXPLORE_ADAPTIVE_FLOW: '1' })).toEqual(tier);
  });
});
