/**
 * Query Signals Handler — shared helpers
 *
 * Extracted from `search-codebase.tool.ts` so that both `search_codebase` and
 * the new `query_signals` tool can hit the underlying VECTOR_SEARCH Cypher
 * without going through `TraversalHandler` (which wraps results in
 * text-formatted traversal output — useful for `search_codebase`, not for a
 * fusing layer).
 *
 * Behavior is logic-preserving: the Cypher params, similarity filter, and row
 * shape mirror what `search-codebase.tool.ts` did inline before extraction.
 *
 * 0013: `searchCodeRaw` accepts `projectIds: string[]` — the VECTOR_SEARCH
 * Cypher uses `IN $projectIds`. Each result row gains a `projectId` field.
 *
 * 0008: `probeEmbeddingsHealth()` fires a 100ms probe against the active
 * embedding provider before invoking the embedder. On probe failure,
 * `query_signals` degrades gracefully instead of wedging for ~120s.
 */

import { getEmbeddingSidecar } from '../../core/embeddings/embedding-sidecar.js';
import { isOpenAIEnabled, isOpenAIAvailable } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';

// ---------------------------------------------------------------------------
// VECTOR_SEARCH — projectIds variant (0013: IN instead of =)
// ---------------------------------------------------------------------------

/**
 * Same Cypher as QUERIES.VECTOR_SEARCH in neo4j.service.ts, but scoped to an
 * array of projectIds so multi-project fan-out works in a single query call.
 * Also projects `node.projectId` alongside other properties.
 */
const VECTOR_SEARCH_MULTI = `
  CALL db.index.vector.queryNodes('embedded_nodes_idx', toInteger($limit * coalesce($fetchMultiplier, 10)), $embedding)
  YIELD node, score
  WHERE node.projectId IN $projectIds AND score >= coalesce($minSimilarity, 0.3)
  WITH node, score
  LIMIT toInteger($limit)
  RETURN {
    id: node.id,
    labels: labels(node),
    properties: apoc.map.removeKeys(properties(node), ['embedding', 'contentHash', 'mtime', 'size'])
  } as node, score, node.projectId AS projectId
  ORDER BY score DESC
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchCodeRawOptions {
  projectIds: string[];
  embedding: number[];
  limit: number;
  minSimilarity: number;
  fetchMultiplier?: number;
}

export interface SearchCodeRawRow {
  node: {
    id: string;
    labels: string[];
    properties: Record<string, unknown>;
  };
  score: number;
  projectId: string;
}

// ---------------------------------------------------------------------------
// searchCodeRaw
// ---------------------------------------------------------------------------

/**
 * Run the project-scoped vector search and return raw {node, score, projectId}
 * rows filtered by minSimilarity. Sorted DESC by score by the underlying Cypher.
 *
 * Caller is responsible for opening/closing the Neo4j service.
 */
export const searchCodeRaw = async (
  neo4jService: Neo4jService,
  { projectIds, embedding, limit, minSimilarity, fetchMultiplier = 10 }: SearchCodeRawOptions,
): Promise<SearchCodeRawRow[]> => {
  const vectorResults = await neo4jService.run(VECTOR_SEARCH_MULTI, {
    limit,
    embedding,
    projectIds,
    fetchMultiplier,
    minSimilarity,
  });

  // Cypher already filters by score >= minSimilarity, but defensive client-side
  // filter mirrors the behavior in `search-codebase.tool.ts` (qualifiedResults).
  return (vectorResults as unknown as SearchCodeRawRow[]).filter((r) => r.score >= minSimilarity);
};

// ---------------------------------------------------------------------------
// projectCodeResult
// ---------------------------------------------------------------------------

/**
 * Project a SearchCodeRawRow into the public query_signals shape.
 * Trims the heavy `sourceCode` field to a configurable snippet.
 */
export const projectCodeResult = (
  row: SearchCodeRawRow,
  snippetLength = 300,
): {
  type: string;
  id: string;
  name: string | null;
  filePath: string | null;
  score: number;
  snippet: string | null;
  projectId: string;
} => {
  const props = row.node.properties as {
    id?: string;
    name?: string;
    filePath?: string;
    sourceCode?: string;
  };
  const labels = row.node.labels ?? [];
  const sourceCode = props.sourceCode ?? null;
  const snippet =
    sourceCode == null
      ? null
      : sourceCode.length <= snippetLength
        ? sourceCode
        : sourceCode.substring(0, snippetLength) + '...';
  return {
    type: labels[0] ?? 'Node',
    id: props.id ?? row.node.id,
    name: props.name ?? null,
    filePath: props.filePath ?? null,
    score: Math.round(row.score * 1000) / 1000,
    snippet,
    projectId: row.projectId,
  };
};

// ---------------------------------------------------------------------------
// probeEmbeddingsHealth (0008)
// ---------------------------------------------------------------------------

/**
 * Fast-fail probe: returns true when the active embedding provider is
 * reachable within `timeoutMs` (default 100ms).
 *
 * - OpenAI path: checks OPENAI_EMBEDDINGS_ENABLED and OPENAI_API_KEY presence
 *   (no network round-trip — key presence is a sufficient liveness signal).
 * - Local sidecar path: fires a single GET /health against the sidecar with a
 *   100ms AbortController timeout. Returns false on any error or timeout.
 *
 * Called once per `query_signals` invocation before touching the embedder.
 * On false: code section returns `skipped: 'embedding-provider-unavailable'`;
 * notes section returns existing notes via Cypher only (no semantic ranking),
 * marked `skipped: 'semantic-ranking-unavailable'`.
 */
export const probeEmbeddingsHealth = async (timeoutMs = 100): Promise<boolean> => {
  if (isOpenAIEnabled()) {
    // For OpenAI, key presence is the only pre-flight check we can do cheaply.
    return isOpenAIAvailable();
  }

  // Local sidecar path — check if the sidecar is already running without
  // triggering the 120-second auto-start sequence.
  const sidecar = getEmbeddingSidecar();
  if (!sidecar.isRunning) {
    // Don't auto-start — that's the 120s wedge we're avoiding.
    return false;
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${sidecar.baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
};
