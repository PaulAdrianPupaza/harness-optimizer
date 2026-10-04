/**
 * RPC-proxy convention synthesizer (HP fork, F3).
 *
 * Cross-process RPC layers often route calls through a dynamic proxy whose
 * methods share a reserved prefix with the remote implementation — VS Code's
 * extension-host protocol is the canonical case: `this._proxy.$executeCommand(…)`
 * in `ExtHostCommands` lands in `MainThreadCommands.$executeCommand` on the
 * other side of the IPC boundary. The proxy object is `any`-typed at the call
 * site, so static resolution leaves those calls as failed references and the
 * flow dead-ends exactly where the agent needs to cross the process boundary
 * (vscode level-1 tasks 02/03 in the TFG benchmark).
 *
 * Rule (deliberately narrow): a FAILED call reference whose name starts with
 * `$` in a JS/TS file is linked to the class methods carrying exactly that
 * name, when there are between 1 and MAX_TARGETS of them. Interface members
 * are skipped (they are contracts, not implementations; the implements edges
 * already lead there). More candidates than that means the name is not a
 * protocol endpoint and nothing is emitted — silent beats wrong.
 */
import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import type { MaybeYield } from './cooperative-yield';

const MAX_TARGETS = 4;
const PROTOCOL_PREFIX = '$';
const IMPLEMENTATION_PARENTS = new Set(['class', 'struct']);

export async function rpcProxyEdges(queries: QueryBuilder, onYield: MaybeYield, languages: string[]): Promise<Edge[]> {
  const refs = queries.getFailedCallRefsWithTailPrefix(PROTOCOL_PREFIX, languages);
  if (refs.length === 0) return [];

  const targetsByName = new Map<string, Node[]>();
  const implementationsOf = (name: string): Node[] => {
    const cached = targetsByName.get(name);
    if (cached) return cached;
    const impls = queries.getNodesByName(name).filter((n) => {
      if (n.kind !== 'method') return false;
      const parent = queries.getIncomingEdges(n.id, ['contains'])
        .map((e) => queries.getNodeById(e.source))
        .find((p): p is Node => !!p);
      return !!parent && IMPLEMENTATION_PARENTS.has(parent.kind);
    });
    const kept = impls.length > 0 && impls.length <= MAX_TARGETS ? impls : [];
    targetsByName.set(name, kept);
    return kept;
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const ref of refs) {
    if ((++n & 63) === 0) await onYield();
    for (const target of implementationsOf(ref.nameTail)) {
      if (target.id === ref.fromNodeId) continue;
      const key = `${ref.fromNodeId}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: ref.fromNodeId,
        target: target.id,
        kind: 'calls',
        line: ref.line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'rpc-proxy',
          via: ref.nameTail,
          registeredAt: `${ref.filePath}:${ref.line}`,
        },
      });
    }
  }
  return edges;
}
