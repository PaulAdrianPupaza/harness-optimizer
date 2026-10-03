import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { SYNTH_PASSES } from '../src/resolution/callback-synthesizer';

// CODEGRAPH_SYNTH_TIMINGS is the profiling surface for synthesis. markPass
// reports each pass without moving the step clock, so 'dedupe-merge' used to
// absorb the whole pass phase (184s on vscode for a sub-second merge). A slow
// pass must show up in passes-wall, not in dedupe-merge.
const PASS_DELAY_MS = 800;

describe('synthesis timing attribution', () => {
  let testDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-synth-timing-'));
    fs.writeFileSync(path.join(testDir, 'a.ts'), 'export function caller() { return callee(); }\nexport function callee() { return 1; }\n');
    prevEnv = process.env.CODEGRAPH_SYNTH_TIMINGS;
    process.env.CODEGRAPH_SYNTH_TIMINGS = 'all';
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CODEGRAPH_SYNTH_TIMINGS;
    else process.env.CODEGRAPH_SYNTH_TIMINGS = prevEnv;
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('charges pass time to passes-wall, not dedupe-merge', async () => {
    const pass = SYNTH_PASSES.find((p) => p.gate((...ls: string[]) => ls.includes('typescript')));
    expect(pass).toBeDefined();
    const original = pass!.run.bind(pass);
    const passSpy = vi.spyOn(pass!, 'run').mockImplementation(async (...args: Parameters<typeof original>) => {
      await new Promise((r) => setTimeout(r, PASS_DELAY_MS));
      return original(...args);
    });
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });

    const cg = CodeGraph.initSync(testDir);
    try {
      await cg.indexAll();
    } finally {
      cg.destroy();
    }

    expect(passSpy).toHaveBeenCalled();
    const ms = (label: string): number => {
      const line = lines.find((l) => l.includes(`[synth-timing] ${label}:`));
      expect(line, `no ${label} timing line`).toBeDefined();
      return Number(/: (\d+)ms/.exec(line!)![1]);
    };
    expect(ms('dedupe-merge')).toBeLessThan(PASS_DELAY_MS / 2);
    expect(ms('passes-wall')).toBeGreaterThanOrEqual(PASS_DELAY_MS);
  }, 30_000);
});
