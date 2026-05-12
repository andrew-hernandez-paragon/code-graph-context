import { LineageRow, RouterRow } from './read-jsonl.js';

export interface CypherEmit {
  query: string;
  params: Record<string, unknown>;
  comment?: string;
}

/**
 * Build the MERGE cypher for a (ToolCall)-[:TOUCHED]->(SourceFile) edge.
 *
 * Both MATCH clauses must succeed for the MERGE to fire — if the SourceFile
 * node does not exist (file outside a parsed project, or project not yet
 * ingested) the statement produces no rows and is silently a no-op.
 * Re-running over the same inputs is idempotent because MERGE de-duplicates
 * the edge.
 */
export const mergeTouched = (toolCallId: string, filePath: string, projectId: string): CypherEmit => ({
  query: `
    MATCH (t:ToolCall { id: $tcid })
    MATCH (sf:SourceFile { projectId: $projectId, filePath: $filePath })
    MERGE (t)-[:TOUCHED]->(sf)
  `.trim(),
  params: { tcid: toolCallId, projectId, filePath },
});

/**
 * Build the MERGE cypher for a ToolCall node.
 *
 * source="cursordiff" is the discriminator the critic flagged — the same
 * schema will carry claude-side telemetry later with source="claude". Without
 * it, cross-source queries would need to introspect node properties to know
 * which extractor produced the row.
 */
export const mergeToolCall = (
  row: LineageRow,
  projectId: string,
  synthetic: boolean,
  routerBySession: Map<string, RouterRow>,
): CypherEmit => {
  const router = routerBySession.get(row.session_id);
  return {
    query: `
      MERGE (t:ToolCall { id: $id })
      SET t.source       = $source,
          t.sessionId    = $sessionId,
          t.projectId    = $projectId,
          t.synthetic    = $synthetic,
          t.toolName     = $toolName,
          t.model        = coalesce($model, t.model),
          t.kind         = $kind,
          t.durationMs   = $durationMs,
          t.success      = $success,
          t.ts           = $ts
      RETURN t.id AS id
    `.trim(),
    params: {
      id: row.tool_call_id,
      source: 'cursordiff',
      sessionId: row.session_id,
      projectId,
      synthetic,
      toolName: row.tool_name ?? null,
      model: row.model ?? router?.picked ?? null,
      kind: row.kind ?? null,
      durationMs: row.duration_ms ?? null,
      success: row.success ?? null,
      ts: row.ts ?? null,
    },
  };
};
