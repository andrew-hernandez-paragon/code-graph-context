import { CypherEmit } from './merge-toolcall.js';
import { DecisionRow } from './read-jsonl.js';

export const mergeDecision = (row: DecisionRow, projectId: string): CypherEmit => {
  // Decision id is deterministic on (hunk_id, outcome, ts) so re-ingesting
  // the same JSONL row is a no-op. Without this, every re-run would create a
  // new Decision node and the RESOLVED_BY edge would multiply.
  const decisionId = `${row.hunk_id}:${row.outcome}:${row.ts ?? 0}`;
  return {
    query: `
      MERGE (d:Decision { id: $id })
      SET d.hunkId    = $hunkId,
          d.filePath  = $filePath,
          d.outcome   = $outcome,
          d.byUser    = $byUser,
          d.sessionId = $sessionId,
          d.projectId = $projectId,
          d.ts        = $ts
      WITH d
      MATCH (h:Hunk { id: $hunkId })
      MERGE (h)-[:RESOLVED_BY]->(d)
      RETURN d.id AS id
    `.trim(),
    params: {
      id: decisionId,
      hunkId: row.hunk_id,
      filePath: row.file_path,
      outcome: row.outcome,
      byUser: row.byUser,
      sessionId: row.session_id ?? null,
      projectId,
      ts: row.ts ?? null,
    },
  };
};
