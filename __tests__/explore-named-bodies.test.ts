/**
 * HP fork (F6) — explore spends its envelope on what the query asked for.
 *
 * Three switches in `src/mcp/explore-budget-policy.ts`, exercised here through
 * the real `codegraph_explore` handler against a real index:
 *
 *   CODEGRAPH_EXPLORE_NAMED_BODIES  a file can hold the bodies of the callables
 *                                   the query NAMED in it (`reserveNamedBodies`)
 *   CODEGRAPH_EXPLORE_FOCUS_META    file headers list definitions, never edge
 *                                   lines (`definitionHeaderSymbols`)
 *   CODEGRAPH_EXPLORE_STRIP_CR      rendered source drops a CRLF checkout's `\r`
 *
 * The fixture is the shape the F6 diagnosis found behind follow-up Reads: the
 * query names a ~70-line method (`processRequest`) in a file that shares the
 * envelope with two well-connected peers whose symbols also match the query.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { getExploreOutputBudget, ToolHandler } from '../src/mcp/tools';
import { DEFAULT_EXPLORE_BUDGET_SCALE } from '../src/mcp/explore-budget-policy';

const FILE_A = 'src/requestPipeline.ts';
const FILE_B = 'src/sessionRegistry.ts';
const FILE_C = 'src/payloadCodec.ts';

/** The bag of names an agent writes: both callables, their class, and the two helper types. */
const QUERY = 'RequestPipeline processRequest reportError SessionRegistry PayloadCodec';
const FILLER_HELPERS = 50;

const F6_SWITCHES = ['CODEGRAPH_EXPLORE_NAMED_BODIES', 'CODEGRAPH_EXPLORE_FOCUS_META', 'CODEGRAPH_EXPLORE_STRIP_CR'] as const;
const SCALE_ENV = 'CODEGRAPH_EXPLORE_BUDGET_SCALE';
/** Everything this suite sets; each is put back to what it found. */
const TOUCHED_ENV = [...F6_SWITCHES, SCALE_ENV] as const;

/** File A: 12 short methods, the long `processRequest`, and a short `reportError`. */
function pipelineSource(): string[] {
  const lines: string[] = [
    "import { SessionRegistry } from './sessionRegistry';",
    "import { PayloadCodec } from './payloadCodec';",
    '',
    'export class RequestPipeline {',
    '  private readonly sessions = new SessionRegistry();',
    '  private readonly codec = new PayloadCodec();',
    '  private handled = 0;',
    '',
  ];
  const short = (name: string, body: string): void => {
    lines.push(`  ${name} {`, `    ${body}`, '  }', '');
  };
  short('countHandled(): number', 'return this.handled;');
  short('resetHandled(): void', 'this.handled = 0;');
  short('hasSession(sessionId: string): boolean', 'return this.sessions.findSession(sessionId) !== undefined;');
  short('describePipeline(): string', "return 'pipeline:' + this.handled + ':' + this.sessions.countSessions();");
  short('encodeHeartbeat(): string', "return this.codec.encodePayloadField('heartbeat', String(this.handled));");
  short('closeAll(): number', 'return this.sessions.resetSessions();');

  // The named ~70-line method.
  lines.push('  processRequest(sessionId: string, rawPayload: string): string {');
  lines.push('    const session = this.sessions.openSession(sessionId);');
  lines.push('    const decoded = this.codec.decodePayload(rawPayload);');
  lines.push('    let accepted = 0;');
  for (let i = 0; i < 9; i++) {
    lines.push(
      `    const step${i} = this.codec.encodePayloadField('step${i}', decoded + ':' + session + ':' + ${i});`,
      `    const weight${i} = this.sessions.touchSession(sessionId, step${i}.length + accepted + ${i});`,
      `    if (step${i}.length > ${100 + i} || weight${i} < 0) {`,
      `      this.reportError('step${i}', 'payload too long at stage ${i} of the request pipeline');`,
      '    } else {',
      `      accepted += this.codec.clampPayloadSize(weight${i}) > 0 ? 1 : 0;`,
      '    }',
    );
  }
  lines.push('    this.handled += accepted;');
  lines.push("    return session + ':' + accepted + ':' + this.codec.clampPayloadSize(decoded.length);");
  lines.push('  }', '');

  short('renewAll(): number', 'return this.sessions.expireSessions(0);');
  short('sizeOf(rawPayload: string): number', 'return this.codec.measurePayload(rawPayload);');
  short('isIdle(): boolean', 'return this.sessions.countSessions() === 0;');
  short('lastSessionIds(): string[]', 'return this.sessions.listSessionIds();');
  short('checksumOf(rawPayload: string): number', 'return this.codec.checksumPayload(rawPayload);');
  short('trimmed(rawPayload: string): string', 'return this.codec.trimPayload(rawPayload);');

  lines.push(
    '  reportError(stage: string, cause: string): string {',
    "    return this.codec.encodePayloadField('error', stage + ':' + cause);",
    '  }',
    '}',
    '',
  );
  // Unrelated module-level helpers: they make the file too long to ship whole
  // (the whole-file rule stops at 280 lines), so its named bodies have to be
  // paid for out of the file's reservation — which is the case under test.
  for (let i = 0; i < FILLER_HELPERS; i++) {
    lines.push(`export function unrelatedHelperNumber${i}(n: number): number {`, `  return n * ${i} + 1;`, '}', '');
  }
  return lines;
}

/** File B: a well-connected helper whose every method matches the query word `session`. */
function registrySource(): string[] {
  return [
    'export class SessionRegistry {',
    '  private readonly sessions = new Map<string, number>();',
    '',
    '  openSession(sessionId: string): string {',
    '    if (this.findSession(sessionId) === undefined) {',
    '      this.sessions.set(sessionId, 0);',
    '    }',
    '    this.touchSession(sessionId, 1);',
    '    return this.describeSession(sessionId);',
    '  }',
    '',
    '  touchSession(sessionId: string, weight: number): number {',
    '    const current = this.findSession(sessionId) ?? 0;',
    '    const next = current + Math.max(1, weight);',
    '    this.sessions.set(sessionId, next);',
    '    return next;',
    '  }',
    '',
    '  closeSession(sessionId: string): boolean {',
    '    const known = this.findSession(sessionId) !== undefined;',
    '    this.sessions.delete(sessionId);',
    '    return known && this.countSessions() >= 0;',
    '  }',
    '',
    '  findSession(sessionId: string): number | undefined {',
    '    const trimmedId = sessionId.trim();',
    '    return this.sessions.get(trimmedId);',
    '  }',
    '',
    '  countSessions(): number {',
    '    const ids = this.listSessionIds();',
    '    return ids.length;',
    '  }',
    '',
    '  expireSessions(olderThan: number): number {',
    '    let expired = 0;',
    '    for (const sessionId of this.listSessionIds()) {',
    '      if ((this.findSession(sessionId) ?? 0) <= olderThan && this.closeSession(sessionId)) {',
    '        expired += 1;',
    '      }',
    '    }',
    '    return expired;',
    '  }',
    '',
    '  renewSession(sessionId: string): string {',
    '    this.closeSession(sessionId);',
    '    return this.openSession(sessionId);',
    '  }',
    '',
    '  describeSession(sessionId: string): string {',
    "    const weight = this.findSession(sessionId) ?? -1;",
    "    return 'session:' + sessionId + ':' + weight + ':' + this.countSessions();",
    '  }',
    '',
    '  listSessionIds(): string[] {',
    '    const ids = [...this.sessions.keys()];',
    '    return ids.sort();',
    '  }',
    '',
    '  resetSessions(): number {',
    '    const before = this.countSessions();',
    '    for (const sessionId of this.listSessionIds()) {',
    '      this.closeSession(sessionId);',
    '    }',
    '    return before;',
    '  }',
    '}',
    '',
  ];
}

/** File C: a well-connected helper whose every method matches the query word `payload`. */
function codecSource(): string[] {
  return [
    'export class PayloadCodec {',
    '  private encoded = 0;',
    '',
    '  decodePayload(rawPayload: string): string {',
    '    const trimmed = this.trimPayload(rawPayload);',
    '    if (!this.isValidPayload(trimmed)) {',
    "      return this.emptyPayload();",
    '    }',
    "    return trimmed.split('|').map((part) => part.trim()).join('|');",
    '  }',
    '',
    '  encodePayloadField(field: string, value: string): string {',
    '    this.encoded += 1;',
    "    const body = field + '=' + this.trimPayload(value);",
    "    return body + '#' + this.checksumPayload(body);",
    '  }',
    '',
    '  clampPayloadSize(size: number): number {',
    '    const limit = this.maxPayloadSize();',
    '    return Math.min(limit, Math.max(0, size));',
    '  }',
    '',
    '  measurePayload(rawPayload: string): number {',
    '    const decoded = this.decodePayload(rawPayload);',
    '    return this.clampPayloadSize(decoded.length);',
    '  }',
    '',
    '  checksumPayload(rawPayload: string): number {',
    '    let sum = 0;',
    '    for (const ch of this.trimPayload(rawPayload)) {',
    '      sum = (sum * 31 + ch.charCodeAt(0)) % 65521;',
    '    }',
    '    return sum;',
    '  }',
    '',
    '  trimPayload(rawPayload: string): string {',
    '    const text = rawPayload.trim();',
    '    return text.slice(0, this.maxPayloadSize());',
    '  }',
    '',
    '  isValidPayload(rawPayload: string): boolean {',
    '    const size = rawPayload.length;',
    '    return size > 0 && size <= this.maxPayloadSize();',
    '  }',
    '',
    '  emptyPayload(): string {',
    "    const marker = this.encodePayloadField('empty', '');",
    "    return marker.slice(0, 0);",
    '  }',
    '',
    '  maxPayloadSize(): number {',
    '    const base = 4096;',
    '    return base + this.encoded * 0;',
    '  }',
    '',
    '  countEncodedPayloads(): number {',
    '    const total = this.encoded;',
    '    return this.clampPayloadSize(total);',
    '  }',
    '}',
    '',
  ];
}

interface Project {
  dir: string;
  cg: CodeGraph;
}

async function buildProject(eol: '\n' | '\r\n'): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-named-bodies-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"named-bodies","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE_A), pipelineSource().join(eol));
  fs.writeFileSync(path.join(dir, FILE_B), registrySource().join(eol));
  fs.writeFileSync(path.join(dir, FILE_C), codecSource().join(eol));
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

/** A fresh handler per call: no session state can leak from one explore into the next. */
async function explore(project: Project, query: string = QUERY): Promise<string> {
  const result = await new ToolHandler(project.cg).execute('codegraph_explore', { query });
  return result.content?.[0]?.text ?? '';
}

/** Lines of one file's section: from its header to the next file header (or the end). */
function fileBlock(response: string, file: string): string[] {
  const lines = response.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`**\`${file}\`**`));
  if (start < 0) return [];
  let end = lines.findIndex((l, i) => i > start && l.startsWith('**`'));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** `<n>\t<text>` for every line of `processRequest`, signature to closing brace. */
function processRequestNumberedLines(): string[] {
  const source = pipelineSource();
  const start = source.findIndex((l) => l.startsWith('  processRequest('));
  const end = source.findIndex((l, i) => i > start && l === '  }');
  expect(start).toBeGreaterThan(0);
  expect(end - start + 1).toBeGreaterThanOrEqual(65); // the ~70-line body the scenario is about
  return source.slice(start, end + 1).map((text, i) => `${start + 1 + i}\t${text}`);
}

function missingFrom(block: string[], wanted: string[]): string[] {
  const have = new Set(block);
  return wanted.filter((l) => !have.has(l));
}

describe('explore — F6 named bodies, definition headers, CR stripping', () => {
  let lf: Project;
  let crlf: Project;
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of TOUCHED_ENV) saved.set(name, process.env[name]);
    lf = await buildProject('\n');
    crlf = await buildProject('\r\n');
  }, 120_000);

  // "Defaults" = what the fork ships: the three switches unset (on) and the
  // fork's own output ceiling. The test sandbox pins the ceiling factor to 1
  // (upstream) for the upstream allocation suites, so it is set back here.
  beforeEach(() => {
    for (const name of F6_SWITCHES) delete process.env[name];
    process.env[SCALE_ENV] = String(DEFAULT_EXPLORE_BUDGET_SCALE);
  });

  afterEach(() => {
    for (const name of TOUCHED_ENV) {
      const before = saved.get(name);
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  });

  afterAll(() => {
    for (const project of [lf, crlf]) {
      project?.cg?.destroy();
      if (project?.dir && fs.existsSync(project.dir)) fs.rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it('renders every line of the named processRequest body, line-numbered, inside its file block', async () => {
    const response = await explore(lf);
    const block = fileBlock(response, FILE_A);
    expect(block.length, response.slice(0, 2000)).toBeGreaterThan(0);
    expect(missingFrom(block, processRequestNumberedLines())).toEqual([]);
    // the other callable the query named is there too
    expect(block.some((l) => /^\d+\t {2}reportError\(stage: string, cause: string\): string \{$/.test(l))).toBe(true);
  });

  // The hp-tfg behaviour, documented rather than condemned. In THIS fixture it
  // is deterministic: file A is reserved by rank alone (~3.7K for a ~4.5K named
  // body), so `processRequest` comes back as its signature, a gap, and its
  // return — the gap the F6 diagnosis found agents Reading. If a later change
  // makes the switch-off path render the whole body too, the last three
  // assertions are the ones to relax; the first two are the contract.
  it('CODEGRAPH_EXPLORE_NAMED_BODIES=0 still answers, with the named body windowed (hp-tfg behaviour)', async () => {
    process.env.CODEGRAPH_EXPLORE_NAMED_BODIES = '0';
    const response = await explore(lf);
    expect(response.length).toBeGreaterThan(0);
    const block = fileBlock(response, FILE_A);
    expect(block.length).toBeGreaterThan(0);

    const wanted = processRequestNumberedLines();
    const missing = missingFrom(block, wanted);
    expect(missing.length).toBeGreaterThan(0);
    expect(block).toContain(wanted[0]); // the signature line still leads the window
    expect(block.some((l) => l.startsWith('... (gap'))).toBe(true);
  });

  it('the re-split moves bytes, it does not add them: named-bodies on stays within the hard ceiling of off', async () => {
    const on = await explore(lf);
    process.env.CODEGRAPH_EXPLORE_NAMED_BODIES = '0';
    const off = await explore(lf);
    // Same budget either way (7,800 for this tier at the fork's 0.6); the
    // render loop may overshoot a reservation by its documented slack, never
    // past 1.5x the budget (the hard ceiling the diagnostic reports).
    const budget = getExploreOutputBudget(3).maxOutputChars * DEFAULT_EXPLORE_BUDGET_SCALE;
    expect(on.length).toBeLessThanOrEqual(budget * 1.5);
    expect(off.length).toBeLessThanOrEqual(budget * 1.5);
    // The peers that donated are still in the response.
    expect(fileBlock(on, FILE_B).length).toBeGreaterThan(0);
    expect(fileBlock(on, FILE_C).length).toBeGreaterThan(0);
  });

  it('file headers list definitions only — no (calls) / (references) entries', async () => {
    const response = await explore(lf);
    const headers = response.split('\n').filter((l) => l.startsWith('**`'));
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header).not.toContain('(calls)');
      expect(header).not.toContain('(references)');
    }
  });

  // Proof the assertion above is not vacuous: this fixture's headers DO carry
  // edge lines once the switch is off (`encodePayloadField(calls)` leads file A's).
  it('CODEGRAPH_EXPLORE_FOCUS_META=0 restores edge lines in file headers (hp-tfg behaviour)', async () => {
    process.env.CODEGRAPH_EXPLORE_FOCUS_META = '0';
    const response = await explore(lf);
    const headers = response.split('\n').filter((l) => l.startsWith('**`'));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.some((h) => h.includes('(calls)'))).toBe(true);
  });

  it('a CRLF checkout renders without \\r by default, named body complete', async () => {
    // The fixture really is CRLF on disk.
    expect(fs.readFileSync(path.join(crlf.dir, FILE_A), 'utf-8')).toContain('\r\n');
    const response = await explore(crlf);
    const block = fileBlock(response, FILE_A);
    expect(block.length).toBeGreaterThan(0);
    expect(response).not.toContain('\r');
    // Line numbers and text are those of the LF fixture: same lines, no `\r`.
    expect(missingFrom(block, processRequestNumberedLines())).toEqual([]);
  });

  it('CODEGRAPH_EXPLORE_STRIP_CR=0 keeps the \\r of a CRLF checkout', async () => {
    process.env.CODEGRAPH_EXPLORE_STRIP_CR = '0';
    const response = await explore(crlf);
    expect(fileBlock(response, FILE_A).length).toBeGreaterThan(0);
    expect(response).toContain('\r');
    // Every rendered source line of file A ends in `\r` — the byte the switch removes.
    const numbered = fileBlock(response, FILE_A).filter((l) => /^\d+\t/.test(l));
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.every((l) => l.endsWith('\r'))).toBe(true);
  });

  it('an LF checkout is rendered identically whether or not CR stripping is on', async () => {
    const on = await explore(lf);
    process.env.CODEGRAPH_EXPLORE_STRIP_CR = '0';
    const off = await explore(lf);
    expect(off).toBe(on);
  });
});
