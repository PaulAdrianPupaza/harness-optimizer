import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

// The orchestrator's durationMs stops when extraction ends; resolution,
// synthesis and maintenance run after it and dominate on large repos
// (vscode: a 25-minute index was reported as "1m 23s"). indexAll/sync must
// report the whole run. A delay injected into a post-extraction step proves it.
const POST_EXTRACTION_DELAY_MS = 1500;
// Slack between our own Date.now() around the call and the engine's internal
// stopwatch (lock acquisition, the post-return finally block).
const SLACK_MS = 250;

describe('index/sync durationMs covers the whole run', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-duration-'));
    fs.writeFileSync(path.join(testDir, 'a.ts'), 'export function caller() { return callee(); }\nexport function callee() { return 1; }\n');
    cg = CodeGraph.initSync(testDir);
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function delayResolution() {
    const resolver = (cg as unknown as { resolver: { resolveDeferredThisMemberRefs: () => Promise<void> } }).resolver;
    const original = resolver.resolveDeferredThisMemberRefs.bind(resolver);
    return vi.spyOn(resolver, 'resolveDeferredThisMemberRefs').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, POST_EXTRACTION_DELAY_MS));
      return original();
    });
  }

  it('indexAll includes post-extraction phases', async () => {
    const spy = delayResolution();
    const t0 = Date.now();
    const result = await cg.indexAll();
    const wall = Date.now() - t0;
    expect(spy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(wall - SLACK_MS);
    expect(result.durationMs).toBeLessThanOrEqual(wall);
  }, 30_000);

  it('sync includes post-extraction phases', async () => {
    await cg.indexAll();
    fs.writeFileSync(path.join(testDir, 'b.ts'), 'import { callee } from "./a";\nexport function other() { return callee(); }\n');
    const resolver = (cg as unknown as { resolver: Record<string, (...a: unknown[]) => unknown> }).resolver;
    const original = resolver.resolveAndPersist.bind(resolver);
    const spy = vi.spyOn(resolver, 'resolveAndPersist').mockImplementation((...args: unknown[]) => {
      const end = Date.now() + POST_EXTRACTION_DELAY_MS;
      while (Date.now() < end) { /* busy-wait: resolveAndPersist is synchronous */ }
      return original(...args);
    });
    const t0 = Date.now();
    const result = await cg.sync();
    const wall = Date.now() - t0;
    expect(spy).toHaveBeenCalled();
    expect(result.filesChecked).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(wall - SLACK_MS);
    expect(result.durationMs).toBeLessThanOrEqual(wall);
  }, 30_000);
});
