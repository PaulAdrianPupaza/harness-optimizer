import { describe, expect, it } from 'vitest';
import {
  adaptBudgetToFlow,
  applyExploreBudgetPolicy,
  compactRelationships,
  compactRelationshipsEnabled,
  blastRadiusFileCaps,
  DEFAULT_EXPLORE_BUDGET_SCALE,
  definitionHeaderSymbols,
  definitionRefs,
  exploreBudgetScale,
  explorePeripheralSkeletonEnabled,
  focusMetaEnabled,
  focusRelationshipEdges,
  LARGE_REPO_EXPLORE_BUDGET_SCALE,
  LARGE_REPO_FILE_COUNT,
  namedBodiesEnabled,
  reserveNamedBodies,
  stripCarriageReturnEnabled,
  stripCarriageReturns,
} from '../src/mcp/explore-budget-policy';
import { getExploreOutputBudget } from '../src/mcp/tools';

describe('explore budget policy (HP fork, F4)', () => {
  it('defaults to the HP-fork ceiling factor and restores upstream at 1', () => {
    const tier = getExploreOutputBudget(10_000);
    expect(exploreBudgetScale({})).toBe(DEFAULT_EXPLORE_BUDGET_SCALE);
    expect(DEFAULT_EXPLORE_BUDGET_SCALE).toBe(0.6);
    expect(applyExploreBudgetPolicy(tier, {}).maxOutputChars).toBe(Math.round(tier.maxOutputChars * 0.6));
    expect(applyExploreBudgetPolicy(tier, { CODEGRAPH_EXPLORE_BUDGET_SCALE: '1' })).toEqual(tier);
    expect(applyExploreBudgetPolicy(tier, {}, { exactTargets: true })).toEqual(tier);
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: 'abc' })).toBe(DEFAULT_EXPLORE_BUDGET_SCALE);
  });

  it('scales the ceilings and clamps the factor to [0.2, 1]', () => {
    const tier = getExploreOutputBudget(10_000);
    const half = applyExploreBudgetPolicy(tier, { CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.5' });
    expect(half.maxOutputChars).toBe(Math.round(tier.maxOutputChars / 2));
    expect(half.maxCharsPerFile).toBe(Math.round(tier.maxCharsPerFile / 2));
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.01' })).toBe(0.2);
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: '3' })).toBe(1);
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

// ── F6: named bodies, focused meta, CR stripping ─────────────────────────────

const sum = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe('reserveNamedBodies (HP fork, F6)', () => {
  const MIN = 500;

  it('returns the allowances unchanged when no file is short', () => {
    const allowances = new Map([['a.ts', 3000], ['b.ts', 2000], ['c.ts', 1000]]);
    const needs = new Map([['a.ts', 3000], ['b.ts', 1200]]); // need == reserved is not short
    const out = reserveNamedBodies(allowances, needs, MIN);
    expect([...out]).toEqual([...allowances]);
    // and with no needs at all
    expect([...reserveNamedBodies(allowances, new Map(), MIN)]).toEqual([...allowances]);
    // the input map is not mutated and the result is a fresh map
    expect(out).not.toBe(allowances);
    expect([...allowances]).toEqual([['a.ts', 3000], ['b.ts', 2000], ['c.ts', 1000]]);
  });

  it('tops a short file up to its need from donors, in proportion to their surplus', () => {
    // a.ts needs 3400 but has 1000 (short 2400). Surplus: b = 4000-500 = 3500, c = 2000-500 = 1500.
    const allowances = new Map([['a.ts', 1000], ['b.ts', 4000], ['c.ts', 2000]]);
    const needs = new Map([['a.ts', 3400]]);
    const out = reserveNamedBodies(allowances, needs, MIN);
    const donors = 2;

    // The short file reaches its need, minus at most one char per donor (flooring).
    expect(out.get('a.ts')!).toBeLessThanOrEqual(3400);
    expect(out.get('a.ts')!).toBeGreaterThanOrEqual(3400 - donors);

    // Donors shrink in proportion to surplus: 2400 * 3500/5000 = 1680, 2400 * 1500/5000 = 720.
    const tookB = 4000 - out.get('b.ts')!;
    const tookC = 2000 - out.get('c.ts')!;
    expect(tookB).toBe(1680);
    expect(tookC).toBe(720);
    expect(tookB / tookC).toBeCloseTo(3500 / 1500, 2);

    // Total never grows, and loses at most one char per file to flooring.
    expect(sum(out)).toBeLessThanOrEqual(sum(allowances));
    expect(sum(out)).toBeGreaterThanOrEqual(sum(allowances) - allowances.size);
  });

  it('floors uneven shares without growing the total', () => {
    // Shortfall 1000 over surpluses 334, 333, 334 (total 1001): no share divides evenly.
    const allowances = new Map([['a.ts', 100], ['b.ts', 834], ['c.ts', 833], ['d.ts', 834]]);
    const needs = new Map([['a.ts', 1100]]);
    const out = reserveNamedBodies(allowances, needs, MIN);
    const donors = 3;
    expect(out.get('a.ts')!).toBeLessThanOrEqual(1100);
    expect(out.get('a.ts')!).toBeGreaterThanOrEqual(1100 - donors);
    expect(sum(out)).toBeLessThanOrEqual(sum(allowances));
    expect(sum(out)).toBeGreaterThanOrEqual(sum(allowances) - allowances.size);
    for (const [path, v] of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      if (path !== 'a.ts') expect(v).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('never takes a donor below minChars nor below its own need', () => {
    // a.ts is short by 10 000 — far more than the donors can give.
    //   b.ts: need 1800 > min → may fall to 1800, no further
    //   c.ts: no need        → may fall to min (500), no further
    //   d.ts: reserved below min already → is not a donor at all
    //   e.ts: need == reserved → not short, no surplus → untouched
    const allowances = new Map([['a.ts', 1000], ['b.ts', 2500], ['c.ts', 2000], ['d.ts', 300], ['e.ts', 900]]);
    const needs = new Map([['a.ts', 11_000], ['b.ts', 1800], ['e.ts', 900]]);
    const out = reserveNamedBodies(allowances, needs, MIN);
    expect(out.get('b.ts')!).toBeGreaterThanOrEqual(1800);
    expect(out.get('c.ts')!).toBeGreaterThanOrEqual(MIN);
    expect(out.get('d.ts')).toBe(300);
    expect(out.get('e.ts')).toBe(900);
    // The whole surplus (700 + 1500) moved, give or take flooring.
    expect(out.get('a.ts')!).toBeLessThanOrEqual(1000 + 2200);
    expect(out.get('a.ts')!).toBeGreaterThanOrEqual(1000 + 2200 - 2);
    expect(sum(out)).toBeLessThanOrEqual(sum(allowances));
    expect(sum(out)).toBeGreaterThanOrEqual(sum(allowances) - allowances.size);

    // Same guarantee when the shortfall is small: donors still respect both floors.
    const small = reserveNamedBodies(allowances, new Map([['a.ts', 1300], ['b.ts', 1800]]), MIN);
    expect(small.get('b.ts')!).toBeGreaterThanOrEqual(1800);
    expect(small.get('c.ts')!).toBeGreaterThanOrEqual(MIN);
    expect(small.get('a.ts')!).toBeLessThanOrEqual(1300);
    expect(small.get('a.ts')!).toBeGreaterThanOrEqual(1300 - 2);
  });

  it('serves shortfalls pro rata when the surplus cannot cover them all', () => {
    // Short: a by 3000, b by 1000 (total 4000). Surplus: c = 1500-500 = 1000, d = 1500-500 = 1000 (total 2000).
    const allowances = new Map([['a.ts', 1000], ['b.ts', 1000], ['c.ts', 1500], ['d.ts', 1500]]);
    const needs = new Map([['a.ts', 4000], ['b.ts', 2000]]);
    const out = reserveNamedBodies(allowances, needs, MIN);

    const gainA = out.get('a.ts')! - 1000;
    const gainB = out.get('b.ts')! - 1000;
    // 2000 moved, split 3:1.
    expect(gainA).toBe(1500);
    expect(gainB).toBe(500);
    // Neither short file is over-served.
    expect(out.get('a.ts')!).toBeLessThanOrEqual(4000);
    expect(out.get('b.ts')!).toBeLessThanOrEqual(2000);
    // Donors are drained to the floor, not past it.
    expect(out.get('c.ts')).toBe(MIN);
    expect(out.get('d.ts')).toBe(MIN);

    expect(sum(out)).toBeLessThanOrEqual(sum(allowances));
    expect(sum(out)).toBeGreaterThanOrEqual(sum(allowances) - allowances.size);
    for (const v of out.values()) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('pro rata with uneven numbers: sum conserved within tolerance, no negatives, nobody over-served', () => {
    const allowances = new Map([['a.ts', 700], ['b.ts', 333], ['c.ts', 1777], ['d.ts', 911], ['e.ts', 1203]]);
    const needs = new Map([['a.ts', 2903], ['b.ts', 1999], ['d.ts', 600]]);
    const out = reserveNamedBodies(allowances, needs, MIN);
    expect(sum(out)).toBeLessThanOrEqual(sum(allowances));
    expect(sum(out)).toBeGreaterThanOrEqual(sum(allowances) - allowances.size);
    for (const v of out.values()) expect(v).toBeGreaterThanOrEqual(0);
    // Both short files gain, in proportion to their shortfalls (2203 : 1666), neither past its need.
    const gainA = out.get('a.ts')! - 700;
    const gainB = out.get('b.ts')! - 333;
    expect(gainA).toBeGreaterThan(0);
    expect(gainB).toBeGreaterThan(0);
    expect(gainA / gainB).toBeCloseTo(2203 / 1666, 1);
    expect(out.get('a.ts')!).toBeLessThanOrEqual(2903);
    expect(out.get('b.ts')!).toBeLessThanOrEqual(1999);
    // Donors keep their floors.
    expect(out.get('c.ts')!).toBeGreaterThanOrEqual(MIN);
    expect(out.get('d.ts')!).toBeGreaterThanOrEqual(600);
    expect(out.get('e.ts')!).toBeGreaterThanOrEqual(MIN);
  });

  it('returns the allowances unchanged when a file is short but nobody has surplus', () => {
    const allowances = new Map([['a.ts', 400], ['b.ts', 500], ['c.ts', 450]]);
    const out = reserveNamedBodies(allowances, new Map([['a.ts', 5000]]), MIN);
    expect([...out]).toEqual([...allowances]);
  });

  it('never admits a path that is in needs but not in allowances', () => {
    const allowances = new Map([['a.ts', 1000], ['b.ts', 4000]]);
    const needs = new Map([['a.ts', 2000], ['cliffed.ts', 3000]]);
    const out = reserveNamedBodies(allowances, needs, MIN);
    expect(out.has('cliffed.ts')).toBe(false);
    expect([...out.keys()]).toEqual(['a.ts', 'b.ts']);
    // ...and its need draws nothing: only a.ts's 1000 shortfall moved.
    expect(out.get('a.ts')).toBe(2000);
    expect(out.get('b.ts')).toBe(3000);

    // A need for an absent path alone is a no-op.
    const noop = reserveNamedBodies(allowances, new Map([['cliffed.ts', 3000]]), MIN);
    expect([...noop]).toEqual([...allowances]);
  });

  it('keeps the insertion (rank) order of allowances', () => {
    const allowances = new Map([['z.ts', 4000], ['m.ts', 800], ['a.ts', 2500], ['k.ts', 600]]);
    // needs listed in a different order on purpose
    const needs = new Map([['k.ts', 2000], ['m.ts', 1900]]);
    const out = reserveNamedBodies(allowances, needs, MIN);
    expect([...out.keys()]).toEqual(['z.ts', 'm.ts', 'a.ts', 'k.ts']);
    expect(out.get('m.ts')!).toBeGreaterThan(800);
    expect(out.get('k.ts')!).toBeGreaterThan(600);
  });
});

describe('focusRelationshipEdges (HP fork, F6)', () => {
  const edges = [
    { source: 'q1', target: 'x', kind: 'calls' },
    { source: 'y', target: 'q2', kind: 'references' },
    { source: 'x', target: 'y', kind: 'calls' },
    { source: 'q1', target: 'q2', kind: 'calls' },
  ];

  it('keeps edges touching a question id on either end, in order, with their extra fields', () => {
    const out = focusRelationshipEdges(edges, new Set(['q1', 'q2']));
    expect(out).toEqual([edges[0], edges[1], edges[3]]);
    expect(focusRelationshipEdges(edges, new Set(['q2']))).toEqual([edges[1], edges[3]]);
    expect(focusRelationshipEdges(edges, new Set(['x']))).toEqual([edges[0], edges[2]]);
  });

  it('returns every edge when there are no question ids', () => {
    const out = focusRelationshipEdges(edges, new Set());
    expect(out).toEqual(edges);
    expect(out).not.toBe(edges); // a copy, the input is readonly
  });

  it('falls back to every edge when no edge touches a question id', () => {
    expect(focusRelationshipEdges(edges, new Set(['nowhere']))).toEqual(edges);
  });

  it('handles an empty edge list', () => {
    expect(focusRelationshipEdges([], new Set(['q1']))).toEqual([]);
    expect(focusRelationshipEdges([], new Set())).toEqual([]);
  });
});

describe('definitionHeaderSymbols (HP fork, F6)', () => {
  it('drops edge-labelled entries and keeps definitions', () => {
    const symbols = [
      'calls(calls)', 'URI(references)', 'x(imports)',
      'foo(method)', 'Bar(class)', 'lines 3-9(range)',
    ];
    expect(definitionHeaderSymbols(symbols)).toEqual(['foo(method)', 'Bar(class)', 'lines 3-9(range)']);
  });

  it('drops every edge kind it knows and preserves the order of what is left', () => {
    const edgeKinds = ['calls', 'references', 'imports', 'exports', 'instantiates', 'extends', 'implements',
      'overrides', 'decorates', 'type_of', 'returns', 'contains', 'navigates'];
    const symbols = ['a(function)', ...edgeKinds.map((k) => `T(${k})`), 'b(interface)', 'c(constant)'];
    expect(definitionHeaderSymbols(symbols)).toEqual(['a(function)', 'b(interface)', 'c(constant)']);
  });

  it('only matches the label at the END of the entry', () => {
    // a definition whose NAME happens to contain an edge word is kept
    expect(definitionHeaderSymbols(['calls(function)', '(calls)handler(method)', 'x(imports)']))
      .toEqual(['calls(function)', '(calls)handler(method)']);
  });

  it('returns an all-edge input unchanged', () => {
    const symbols = ['calls(calls)', 'URI(references)', 'x(imports)'];
    expect(definitionHeaderSymbols(symbols)).toEqual(symbols);
    expect(definitionHeaderSymbols([])).toEqual([]);
  });
});

describe('blastRadiusFileCaps (HP fork, F6)', () => {
  it('lists 2 caller files and 1 test file by default', () => {
    expect(blastRadiusFileCaps({})).toEqual({ callers: 2, tests: 1 });
    expect(blastRadiusFileCaps({ CODEGRAPH_EXPLORE_FOCUS_META: '1' })).toEqual({ callers: 2, tests: 1 });
  });

  it('restores 4 and 4 with CODEGRAPH_EXPLORE_FOCUS_META=0', () => {
    expect(blastRadiusFileCaps({ CODEGRAPH_EXPLORE_FOCUS_META: '0' })).toEqual({ callers: 4, tests: 4 });
    expect(blastRadiusFileCaps({ CODEGRAPH_EXPLORE_FOCUS_META: 'false' })).toEqual({ callers: 4, tests: 4 });
  });
});

describe('stripCarriageReturns (HP fork, F6)', () => {
  it('turns CRLF into LF', () => {
    expect(stripCarriageReturns('a\r\nb\r\n\r\nc', {})).toBe('a\nb\n\nc');
  });

  it('returns LF-only text identical', () => {
    const text = 'a\nb\n\nc\n';
    expect(stripCarriageReturns(text, {})).toBe(text);
    expect(stripCarriageReturns('', {})).toBe('');
  });

  it('leaves the text unchanged when the switch is off', () => {
    const text = 'a\r\nb\r\n';
    expect(stripCarriageReturns(text, { CODEGRAPH_EXPLORE_STRIP_CR: '0' })).toBe(text);
    expect(stripCarriageReturns(text, { CODEGRAPH_EXPLORE_STRIP_CR: 'false' })).toBe(text);
  });

  it('preserves a lone \\r that is not followed by \\n', () => {
    expect(stripCarriageReturns('a\rb', {})).toBe('a\rb');
    expect(stripCarriageReturns('a\rb\r\nc\r', {})).toBe('a\rb\nc\r');
    expect(stripCarriageReturns('a\r\rb\r\r\nc', {})).toBe('a\r\rb\r\nc');
  });
});

describe('F6 switches', () => {
  const switches: Array<[string, (env: NodeJS.ProcessEnv) => boolean]> = [
    ['CODEGRAPH_EXPLORE_NAMED_BODIES', namedBodiesEnabled],
    ['CODEGRAPH_EXPLORE_FOCUS_META', focusMetaEnabled],
    ['CODEGRAPH_EXPLORE_STRIP_CR', stripCarriageReturnEnabled],
  ];

  it.each(switches)('%s: on when unset, off at 0/false, on at 1', (name, enabled) => {
    expect(enabled({})).toBe(true);
    expect(enabled({ [name]: '0' })).toBe(false);
    expect(enabled({ [name]: 'false' })).toBe(false);
    expect(enabled({ [name]: '1' })).toBe(true);
  });

  it('each switch reads only its own variable', () => {
    for (const [name, enabled] of switches) {
      const others = Object.fromEntries(switches.filter(([n]) => n !== name).map(([n]) => [n, '0']));
      expect(enabled(others), name).toBe(true);
    }
  });
});

describe('large-repo ceiling and exact-target exemption (HP fork, F6)', () => {
  it('uses the large-repo factor from LARGE_REPO_FILE_COUNT files up, unless overridden', () => {
    expect(LARGE_REPO_FILE_COUNT).toBe(5000);
    expect(LARGE_REPO_EXPLORE_BUDGET_SCALE).toBe(0.5);
    expect(exploreBudgetScale({}, LARGE_REPO_FILE_COUNT - 1)).toBe(DEFAULT_EXPLORE_BUDGET_SCALE);
    expect(exploreBudgetScale({}, LARGE_REPO_FILE_COUNT)).toBe(LARGE_REPO_EXPLORE_BUDGET_SCALE);
    expect(exploreBudgetScale({}, 50_000)).toBe(LARGE_REPO_EXPLORE_BUDGET_SCALE);
    expect(exploreBudgetScale({})).toBe(DEFAULT_EXPLORE_BUDGET_SCALE); // no file count → small-repo default
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_LARGE_REPO_SCALE: '0' }, 50_000)).toBe(DEFAULT_EXPLORE_BUDGET_SCALE);
    // An explicit factor wins at any size; a malformed one falls back to the size default.
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: '0.8' }, 50_000)).toBe(0.8);
    expect(exploreBudgetScale({ CODEGRAPH_EXPLORE_BUDGET_SCALE: 'abc' }, 50_000)).toBe(LARGE_REPO_EXPLORE_BUDGET_SCALE);
  });

  it('applyExploreBudgetPolicy scales by file count', () => {
    const tier = getExploreOutputBudget(10_000);
    const big = applyExploreBudgetPolicy(tier, {}, { fileCount: 10_000 });
    expect(big.maxOutputChars).toBe(Math.round(tier.maxOutputChars * LARGE_REPO_EXPLORE_BUDGET_SCALE));
    const mid = getExploreOutputBudget(1_000);
    expect(applyExploreBudgetPolicy(mid, {}, { fileCount: 1_000 }).maxOutputChars)
      .toBe(Math.round(mid.maxOutputChars * DEFAULT_EXPLORE_BUDGET_SCALE));
  });

  it('exact targets keep the upstream ceiling unless CODEGRAPH_EXPLORE_EXACT_SCALED=1 on a call without line anchors', () => {
    const tier = getExploreOutputBudget(10_000);
    expect(applyExploreBudgetPolicy(tier, {}, { exactTargets: true, lineAnchors: false, fileCount: 10_000 })).toEqual(tier);
    const opt = { CODEGRAPH_EXPLORE_EXACT_SCALED: '1' };
    expect(applyExploreBudgetPolicy(tier, opt, { exactTargets: true, lineAnchors: false, fileCount: 10_000 }).maxOutputChars)
      .toBe(Math.round(tier.maxOutputChars * LARGE_REPO_EXPLORE_BUDGET_SCALE));
    // a line anchor always keeps the ceiling; so do an unknown anchor state and named bodies off
    expect(applyExploreBudgetPolicy(tier, opt, { exactTargets: true, lineAnchors: true })).toEqual(tier);
    expect(applyExploreBudgetPolicy(tier, opt, { exactTargets: true })).toEqual(tier);
    expect(applyExploreBudgetPolicy(tier, { ...opt, CODEGRAPH_EXPLORE_NAMED_BODIES: '0' }, { exactTargets: true, lineAnchors: false }))
      .toEqual(tier);
  });
});

describe('definitionRefs (HP fork, F6)', () => {
  it('drops refs whose kind is an edge kind and keeps definitions, in order', () => {
    const refs = [
      { name: 'a', kind: 'method' }, { name: 'b', kind: 'calls' }, { name: 'c', kind: 'class' },
      { name: 'd', kind: 'references' }, { name: 'e', kind: 'imports' }, { name: 'f', kind: 'function' },
    ];
    expect(definitionRefs(refs).map((r) => r.name)).toEqual(['a', 'c', 'f']);
    expect(definitionRefs([])).toEqual([]);
  });

  it('unlike definitionHeaderSymbols, returns an empty list when every ref is an edge', () => {
    expect(definitionRefs([{ kind: 'calls' }, { kind: 'references' }])).toEqual([]);
  });
});
