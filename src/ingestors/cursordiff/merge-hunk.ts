import { CypherEmit } from './merge-toolcall.js';
import { LineageRow } from './read-jsonl.js';

export const mergeHunk = (row: LineageRow, projectId: string): CypherEmit => ({
  query: `
    MERGE (h:Hunk { id: $id })
    SET h.toolCallId = $toolCallId,
        h.projectId  = $projectId,
        h.filePath   = $filePath,
        h.oldHash    = $oldHash,
        h.newHash    = $newHash,
        h.oldLen     = $oldLen,
        h.newLen     = $newLen,
        h.ts         = $ts
    RETURN h.id AS id
  `.trim(),
  params: {
    id: row.hunk_id,
    toolCallId: row.tool_call_id,
    projectId,
    filePath: row.path,
    oldHash: row.old_hash,
    newHash: row.new_hash,
    oldLen: row.old_len ?? null,
    newLen: row.new_len ?? null,
    ts: row.ts ?? null,
  },
});

export const mergeProduced = (row: LineageRow): CypherEmit => ({
  query: `
    MATCH (t:ToolCall { id: $tcid }), (h:Hunk { id: $hid })
    MERGE (t)-[:PRODUCED]->(h)
  `.trim(),
  params: { tcid: row.tool_call_id, hid: row.hunk_id },
});
