import { CypherEmit } from '../cursordiff/merge-toolcall.js';
import { DeliberationRow } from './read-jsonl.js';

export const mergeDeliberation = (row: DeliberationRow): CypherEmit => ({
  query: `
    MERGE (d:Deliberation { id: $id })
    SET d.topic            = $topic,
        d.projectIds       = $projectIds,
        d.mode             = $mode,
        d.status           = $status,
        d.aboutNodeIds     = $aboutNodeIds,
        d.triggeredBy      = $triggeredBy,
        d.sessionId        = $sessionId,
        d.ts               = $ts
    RETURN d.id AS id
  `.trim(),
  params: {
    id: row.id,
    topic: row.topic,
    projectIds: row.projectIds ?? [],
    mode: row.mode,
    status: row.status,
    aboutNodeIds: row.aboutNodeIds ?? [],
    triggeredBy: row.triggeredBy ?? null,
    sessionId: row.sessionId ?? null,
    ts: row.ts ?? null,
  },
});

/**
 * Emit a SCOPED_TO edge from a Deliberation to a Project node.
 * Uses MATCH on Project so the edge is silently a no-op when the project node
 * does not exist yet (ensureProjectNode handles creation separately).
 */
export const mergeScopedTo = (deliberationId: string, projectId: string): CypherEmit => ({
  query: `
    MATCH (d:Deliberation { id: $did })
    MATCH (p:Project { projectId: $projectId })
    MERGE (d)-[:SCOPED_TO]->(p)
  `.trim(),
  params: { did: deliberationId, projectId },
});

/**
 * Emit an ABOUT edge from a Deliberation to any node by ID.
 * Silently no-op when the target node doesn't exist.
 */
export const mergeAbout = (deliberationId: string, nodeId: string, kind: 'primary' | 'context'): CypherEmit => ({
  query: `
    MATCH (d:Deliberation { id: $did })
    MATCH (n { id: $nodeId })
    MERGE (d)-[:ABOUT { kind: $kind }]->(n)
  `.trim(),
  params: { did: deliberationId, nodeId, kind },
});
