import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

// HP fork (F3). VS Code's extension host calls the main thread through an
// `any`-typed proxy: `this._proxy.$executeCommand(…)` resolves statically to
// nothing, so the flow dead-ended at the IPC boundary. The rpc-proxy pass links
// such failed `$`-prefixed calls to the class methods of that exact name.
describe('rpc-proxy synthesizer', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rpc-proxy-'));
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): void => fs.writeFileSync(path.join(dir, name), body);

  const calleesOf = (name: string): string[] => {
    const node = cg!.searchNodes(name).map((r) => r.node).find((n) => n.name === name && n.kind === 'method');
    expect(node, `method ${name}`).toBeDefined();
    return cg!.getCallees(node!.id).map((c) => `${c.node.name}@${path.basename(c.node.filePath)}`);
  };

  it('links a proxy $call to the remote implementation, not to the interface', async () => {
    write('protocol.ts', 'export interface MainThreadCommandsShape { $executeCommand(id: string): number; }\n');
    write('extHostCommands.ts', [
      'export class ExtHostCommands {',
      '  private _proxy: any;',
      '  executeCommand(id: string) { return this._proxy.$executeCommand(id); }',
      '}',
      '',
    ].join('\n'));
    write('mainThreadCommands.ts', [
      'import { MainThreadCommandsShape } from "./protocol";',
      'export class MainThreadCommands implements MainThreadCommandsShape {',
      '  $executeCommand(id: string) { return id.length; }',
      '}',
      '',
    ].join('\n'));
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(calleesOf('executeCommand')).toContain('$executeCommand@mainThreadCommands.ts');
    expect(calleesOf('executeCommand')).not.toContain('$executeCommand@protocol.ts');
  }, 60_000);

  it('emits nothing when the $name has too many implementations to be an endpoint', async () => {
    const impls = Array.from({ length: 6 }, (_, i) => `export class Impl${i} { $run() { return ${i}; } }`);
    write('impls.ts', impls.join('\n') + '\n');
    write('caller.ts', 'export class Caller { private _proxy: any; go() { return this._proxy.$run(); } }\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(calleesOf('go').filter((c) => c.startsWith('$run@'))).toEqual([]);
  }, 60_000);
});
