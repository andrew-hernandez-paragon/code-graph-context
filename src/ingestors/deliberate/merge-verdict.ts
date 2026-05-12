import { CypherEmit } from '../cursordiff/merge-toolcall.js';
import { VerdictRow } from './read-jsonl.js';

export const mergeVerdict = (row: VerdictRow): CypherEmit => ({
  query: `
    MERGE (v:Verdict { id: $id })
    SET v.deliberationId = $deliberationId,
        v.verdict        = $verdict,
        v.rationale      = $rationale,
        v.recordedIn     = $recordedIn,
        v.agentId        = $agentId,
        v.ts             = $ts
    RETURN v.id AS id
  `.trim(),
  params: {
    id: row.id,
    deliberationId: row.deliberationId,
    verdict: row.verdict,
    rationale: row.rationale,
    recordedIn: row.recordedIn ?? null,
    agentId: row.agentId ?? null,
    ts: row.ts ?? null,
  },
});

export const mergeResultedIn = (deliberationId: string, verdictId: string): CypherEmit => ({
  query: `
    MATCH (d:Deliberation { id: $did }), (v:Verdict { id: $vid })
    MERGE (d)-[:RESULTED_IN]->(v)
  `.trim(),
  params: { did: deliberationId, vid: verdictId },
});
