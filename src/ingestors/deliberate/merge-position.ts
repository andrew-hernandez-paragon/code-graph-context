import { CypherEmit } from '../cursordiff/merge-toolcall.js';
import { PositionRow } from './read-jsonl.js';

export const mergePosition = (row: PositionRow): CypherEmit => ({
  query: `
    MERGE (p:Position { id: $id })
    SET p.deliberationId = $deliberationId,
        p.role           = $role,
        p.content        = $content,
        p.claims         = $claims,
        p.evidence       = $evidence,
        p.counterArgs    = $counterArgs,
        p.status         = $status,
        p.agentId        = $agentId,
        p.ts             = $ts
    RETURN p.id AS id
  `.trim(),
  params: {
    id: row.id,
    deliberationId: row.deliberationId,
    role: row.role,
    content: row.content,
    claims: row.claims ?? [],
    evidence: row.evidence ?? [],
    counterArgs: row.counterArgs ?? [],
    status: row.status,
    agentId: row.agentId ?? null,
    ts: row.ts ?? null,
  },
});

export const mergeHasPosition = (deliberationId: string, positionId: string): CypherEmit => ({
  query: `
    MATCH (d:Deliberation { id: $did }), (p:Position { id: $pid })
    MERGE (d)-[:HAS_POSITION]->(p)
  `.trim(),
  params: { did: deliberationId, pid: positionId },
});

/**
 * Emit a CITES edge from a Position to any node.
 * Silently no-op when the target node doesn't exist.
 */
export const mergeCites = (positionId: string, nodeId: string, kind: 'evidence' | 'counter-example'): CypherEmit => ({
  query: `
    MATCH (p:Position { id: $pid })
    MATCH (n { id: $nodeId })
    MERGE (p)-[:CITES { kind: $kind }]->(n)
  `.trim(),
  params: { pid: positionId, nodeId, kind },
});
