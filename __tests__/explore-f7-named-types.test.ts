/**
 * HP fork (F7) — the Reads agents still made after explore in the F6 sessions
 * (knowledge-base/F7/00-diagnostico-reads.md), turned into fixtures:
 *
 *   CODEGRAPH_EXPLORE_LOWER_TYPES  a camelCase token that names a type is a type token. Go's
 *                                  unexported `jsonBinding` must pick `jsonBinding.Bind` out of
 *                                  a family of `Bind`s and bring its file whole (gin-04).
 *   CODEGRAPH_EXPLORE_NAMED_CTORS  the constructor of a class the query named is reserved like a
 *                                  named callable (vscode-04: `ModelTracker`'s constructor wires
 *                                  the listener the question is about).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { DEFAULT_EXPLORE_BUDGET_SCALE } from '../src/mcp/explore-budget-policy';

const SWITCHES = ['CODEGRAPH_EXPLORE_LOWER_TYPES', 'CODEGRAPH_EXPLORE_NAMED_CTORS', 'CODEGRAPH_EXPLORE_NAMED_WHOLE'] as const;
const TOUCHED = [...SWITCHES, 'CODEGRAPH_EXPLORE_BUDGET_SCALE'] as const;

interface Project { dir: string; cg: CodeGraph }

async function build(files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-f7-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

async function explore(p: Project, query: string): Promise<string> {
  const r = await new ToolHandler(p.cg).execute('codegraph_explore', { query });
  return r.content?.[0]?.text ?? '';
}

function fileBlock(response: string, file: string): string[] {
  const lines = response.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`**\`${file}\`**`));
  if (start < 0) return [];
  let end = lines.findIndex((l, i) => i > start && l.startsWith('**`'));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** `<n>\t<text>` lines of `source` from the first line matching `startRe` to the next `closing`. */
function numbered(source: string, startRe: RegExp, closing: string): string[] {
  const lines = source.split('\n');
  const s = lines.findIndex((l) => startRe.test(l));
  const e = lines.findIndex((l, i) => i > s && l === closing);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(e).toBeGreaterThan(s);
  return lines.slice(s, e + 1).map((t, i) => `${s + 1 + i}\t${t}`);
}

// ── Go: a family of Bind implementations, one of them named by its lower-case type ──────────

const BINDINGS = ['form', 'query', 'header', 'xml', 'yaml', 'toml', 'plain', 'msgpack'];

function bindingSource(kind: string): string {
  const T = `${kind}Binding`;
  return [
    'package binding',
    '',
    'import "net/http"',
    '',
    `type ${T} struct{}`,
    '',
    `func (${T}) Name() string {`,
    `\treturn "${kind}"`,
    '}',
    '',
    `func (${T}) Bind(req *http.Request, obj any) error {`,
    '\tif req == nil {',
    '\t\treturn nil',
    '\t}',
    // longer than jsonBinding's Bind: a body-size pick among the family never lands on json.go
    ...Array.from({ length: 12 }, (_, i) => `\tif req.ContentLength == ${i} {\n\t\treturn validate(obj)\n\t}`),
    `\treturn decode${kind[0]!.toUpperCase()}${kind.slice(1)}(req, obj)`,
    '}',
    '',
    `func decode${kind[0]!.toUpperCase()}${kind.slice(1)}(req *http.Request, obj any) error {`,
    '\treturn validate(obj)',
    '}',
    '',
  ].join('\n');
}

const JSON_GO = [
  'package binding',
  '',
  'import (',
  '\t"encoding/json"',
  '\t"net/http"',
  ')',
  '',
  'type jsonBinding struct{}',
  '',
  'func (jsonBinding) Name() string {',
  '\treturn "json"',
  '}',
  '',
  'func (jsonBinding) Bind(req *http.Request, obj any) error {',
  '\tif req == nil || req.Body == nil {',
  '\t\treturn nil',
  '\t}',
  '\treturn decodeJSON(req, obj)',
  '}',
  '',
  'func decodeJSON(req *http.Request, obj any) error {',
  '\tdecoder := json.NewDecoder(req.Body)',
  '\tif EnableDecoderUseNumber {',
  '\t\tdecoder.UseNumber()',
  '\t}',
  '\tif err := decoder.Decode(obj); err != nil {',
  '\t\treturn err',
  '\t}',
  '\treturn validate(obj)',
  '}',
  '',
].join('\n');

const BINDING_GO = [
  'package binding',
  '',
  'import "net/http"',
  '',
  'var EnableDecoderUseNumber = false',
  '',
  'type Binding interface {',
  '\tName() string',
  '\tBind(*http.Request, any) error',
  '}',
  '',
  'func validate(obj any) error {',
  '\tif obj == nil {',
  '\t\treturn nil',
  '\t}',
  '\treturn nil',
  '}',
  '',
].join('\n');

const CONTEXT_GO = [
  'package gin',
  '',
  'import (',
  '\t"net/http"',
  '\t"example.com/app/binding"',
  ')',
  '',
  'type Context struct {',
  '\tRequest *http.Request',
  '}',
  '',
  'func (c *Context) ShouldBindWith(obj any, b binding.Binding) error {',
  '\treturn b.Bind(c.Request, obj)',
  '}',
  '',
  'func (c *Context) ShouldBindQuery(obj any, b binding.Binding) error {',
  '\treturn b.Bind(c.Request, obj)',
  '}',
  '',
].join('\n');

// ── TypeScript: a named class whose constructor wires the flow ───────────────────────────────

const TRACKER_TS = (() => {
  const out = [
    "import { DocumentSync } from './documentSync';",
    '',
    'export class ModelTracker {',
    '  private disposed = false;',
    '  private listeners: Array<() => void> = [];',
    '',
  ];
  // the constructor sits deep in a long class, as vscode's does: nothing but its own
  // importance can bring it into the render
  for (let i = 0; i < 60; i++) {
    out.push(`  early${i}(): number {`, `    return this.listeners.length * ${i};`, '  }', '');
  }
  out.push(
    '  constructor(private readonly model: { onDidChangeContent(cb: (e: string) => void): void; uri: string; version: number },',
    '              private readonly sync: DocumentSync) {',
  );
  for (let i = 0; i < 30; i++) out.push(`    const step${i} = this.model.version + ${i};`);
  out.push(
    '    this.model.onDidChangeContent((e) => {',
    '      if (this.disposed) { return; }',
    '      this.sync.acceptModelChanged(this.model.uri, e, this.model.version);',
    '    });',
    '  }',
    '',
  );
  // a file well past the whole-file rule, so the constructor has to EARN its place in the render
  for (let i = 0; i < 90; i++) {
    out.push(`  helper${i}(): number {`, `    return this.model.version * ${i};`, '  }', '');
  }
  out.push('  dispose(): void {', '    this.disposed = true;', '  }', '}', '');
  return out.join('\n');
})();

const SYNC_TS = (() => {
  const out = ['export class DocumentSync {', '  private versions = new Map<string, number>();', ''];
  out.push(
    '  acceptModelChanged(uri: string, change: string, version: number): void {',
    '    this.versions.set(uri, version);',
    '    this.forward(uri, change);',
    '  }',
    '',
    '  forward(uri: string, change: string): void {',
    '    this.versions.set(uri + change, 0);',
    '  }',
    '',
  );
  for (let i = 0; i < 12; i++) {
    out.push(`  syncHelper${i}(uri: string): number {`, `    return (this.versions.get(uri) ?? 0) + ${i};`, '  }', '');
  }
  out.push('}', '');
  return out.join('\n');
})();

describe('explore — F7 named types and constructors', () => {
  let go: Project;
  let ts: Project;
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const n of TOUCHED) saved.set(n, process.env[n]);
    const goFiles: Record<string, string> = {
      'go.mod': 'module example.com/app\n\ngo 1.21\n',
      'binding/binding.go': BINDING_GO,
      'binding/json.go': JSON_GO,
      'context.go': CONTEXT_GO,
    };
    for (const k of BINDINGS) goFiles[`binding/${k}.go`] = bindingSource(k);
    go = await build(goFiles);
    ts = await build({
      'package.json': '{"name":"f7","version":"1.0.0"}\n',
      'src/modelTracker.ts': TRACKER_TS,
      'src/documentSync.ts': SYNC_TS,
    });
  }, 180_000);

  beforeEach(() => {
    for (const n of SWITCHES) delete process.env[n];
    process.env.CODEGRAPH_EXPLORE_BUDGET_SCALE = String(DEFAULT_EXPLORE_BUDGET_SCALE);
  });

  afterEach(() => {
    for (const n of TOUCHED) {
      const before = saved.get(n);
      if (before === undefined) delete process.env[n];
      else process.env[n] = before;
    }
  });

  afterAll(() => {
    for (const p of [go, ts]) {
      p?.cg?.destroy();
      if (p?.dir && fs.existsSync(p.dir)) fs.rmSync(p.dir, { recursive: true, force: true });
    }
  });

  const GO_QUERY = 'ShouldBindWith jsonBinding Bind';

  it('LOWER_TYPES: a lower-case Go type picks its own Bind and its file ships with the body', async () => {
    const response = await explore(go, GO_QUERY);
    const block = fileBlock(response, 'binding/json.go');
    expect(block.length, response.slice(0, 3000)).toBeGreaterThan(0);
    const missing = numbered(JSON_GO, /^func \(jsonBinding\) Bind\(/, '}').filter((l) => !block.includes(l));
    expect(missing).toEqual([]);
  });

  it('LOWER_TYPES=0 still answers (hp-tfg-v2 behaviour)', async () => {
    process.env.CODEGRAPH_EXPLORE_LOWER_TYPES = '0';
    const response = await explore(go, GO_QUERY);
    expect(response.length).toBeGreaterThan(0);
  });

  const TS_QUERY = 'ModelTracker DocumentSync acceptModelChanged';

  it('NAMED_CTORS: the constructor of a named class is rendered whole', async () => {
    const response = await explore(ts, TS_QUERY);
    const block = fileBlock(response, 'src/modelTracker.ts');
    expect(block.length, response.slice(0, 3000)).toBeGreaterThan(0);
    const ctor = numbered(TRACKER_TS, /^ {2}constructor\(/, '  }');
    expect(ctor.length).toBeGreaterThan(30);
    expect(ctor.filter((l) => !block.includes(l))).toEqual([]);
  });

  it('NAMED_CTORS=0 still answers (hp-tfg-v2 behaviour)', async () => {
    process.env.CODEGRAPH_EXPLORE_NAMED_CTORS = '0';
    const response = await explore(ts, TS_QUERY);
    expect(fileBlock(response, 'src/modelTracker.ts').length).toBeGreaterThan(0);
  });
});
