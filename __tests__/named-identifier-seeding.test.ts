import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

// HP fork (F3). Identifiers the query names must seed the search even when
// they are acronym-led (`RPCProtocol`) or `_`/`$`-prefixed (`_receiveOne`,
// `$executeCommand`) — shapes the query tokenizer used to drop — and must keep
// a root even when prose words in the same query ("extension host") match many
// more multi-term symbols. On vscode, "extension host RPCProtocol" returned
// eight *ExtensionHost* roots and never rpcProtocol.ts.
describe('named identifiers seed explore even among prose decoys', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-named-seed-'));
    const decoys: string[] = [];
    for (let i = 0; i < 30; i++) {
      decoys.push(`export class ExtensionHostPart${i} { hostExtension${i}() { return ${i}; } }`);
    }
    fs.writeFileSync(path.join(dir, 'decoys.ts'), decoys.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'rpc.ts'), [
      'export class RPCProtocol {',
      '  _receiveOne(msg: string) { return this.$executeCommand(msg); }',
      '  $executeCommand(id: string) { return id.length; }',
      '}',
      '',
    ].join('\n'));
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  }, 60_000);

  afterEach(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rootNames = async (query: string): Promise<string[]> => {
    const sg = await cg.findRelevantContext(query, { searchLimit: 8, traversalDepth: 3, maxNodes: 200, minScore: 0.2 });
    return sg.roots.map((id) => sg.nodes.get(id)?.name ?? '');
  };

  it('keeps an acronym-led class the query names', async () => {
    expect(await rootNames('extension host RPCProtocol')).toContain('RPCProtocol');
  });

  it('seeds _- and $-prefixed members', async () => {
    const roots = await rootNames('extension host _receiveOne $executeCommand');
    expect(roots).toContain('_receiveOne');
    expect(roots).toContain('$executeCommand');
  });
});
