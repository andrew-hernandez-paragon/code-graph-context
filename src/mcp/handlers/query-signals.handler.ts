/**
 * Query Signals Handler — shared helpers
 *
 * Extracted from `search-codebase.tool.ts` so that both `search_codebase` and
 * the new `query_signals` tool can hit the underlying vector search Cypher
 * without going through `TraversalHandler` (which wraps results in
 * text-formatted traversal output — useful for `search_codebase`, not for a
 * fusing layer).
 *
 * Behavior is logic-preserving: the Cypher params, similarity filter, and row
 * shape mirror what `search-codebase.tool.ts` did inline before extraction.
 *
 * 0013: `searchCodeRaw` accepts `projectIds: string[]`, searched once per
 * project inside the vector index. Each result row gains a `projectId` field.
 *
 * 0014: `searchCodeHybrid` adds a BM25 channel alongside the vector channel
 * and fuses the two by reciprocal rank. `searchCodeRaw` is unchanged so
 * `query_signals`, which reports per-source sections rather than a fused
 * list, keeps its existing behavior.
 *
 * 0008: `probeEmbeddingsHealth()` fires a 100ms probe against the active
 * embedding provider before invoking the embedder. On probe failure,
 * `query_signals` degrades gracefully instead of wedging for ~120s.
 */

import { getEmbeddingSidecar } from '../../core/embeddings/embedding-sidecar.js';
import { isOpenAIEnabled, isOpenAIAvailable } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { nearestNeighborsInProjects, runProjectFilteredSearch } from '../../storage/neo4j/project-vector-search.js';
import { VECTOR_INDEXES } from '../../storage/neo4j/vector-indexes.js';
import { debugLog } from '../utils.js';

// ---------------------------------------------------------------------------
// VECTOR_SEARCH_MULTI: filtered inside the index, one search per project
// ---------------------------------------------------------------------------

const VECTOR_SEARCH_MULTI = `
  ${nearestNeighborsInProjects({
    index: VECTOR_INDEXES.embeddedNodes,
    node: 'node',
    score: 'score',
    queryVector: '$embedding',
    neighbors: '$limit',
  })}
  WITH node, score
  WHERE score >= coalesce($minSimilarity, 0.3)
  ORDER BY score DESC
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
  { projectIds, embedding, limit, minSimilarity }: SearchCodeRawOptions,
): Promise<SearchCodeRawRow[]> => {
  const vectorResults = await runProjectFilteredSearch(
    neo4jService,
    VECTOR_INDEXES.embeddedNodes,
    VECTOR_SEARCH_MULTI,
    {
      limit,
      embedding,
      projectIds,
      minSimilarity,
    },
  );

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
 *   The 100ms timeout is the wedge-prevention: a healthy sidecar replies in
 *   ~40ms; anything slower means it's still loading and would block embed
 *   calls for ~120s. We do NOT check `sidecar.isRunning` first — that flag
 *   is process-local (only true when this MCP generation spawned the sidecar
 *   itself) and lies when the sidecar was started externally or by a prior
 *   MCP generation. Trust the network: if /health says 200, it's up.
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

  // Local sidecar path — probe the network endpoint directly. Do NOT short-
  // circuit on `sidecar.isRunning`; that flag misreports externally-started
  // sidecars. The 100ms timeout still prevents blocking on a cold-loading
  // sidecar that hasn't bound the port yet.
  const sidecar = getEmbeddingSidecar();
  try {
    return await sidecar.checkHealth(timeoutMs);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Lexical (BM25) channel — 0014
// ---------------------------------------------------------------------------

/**
 * BM25 counterpart to VECTOR_SEARCH_MULTI over the same :Embedded nodes.
 *
 * No minSimilarity gate here on purpose: Lucene scores are unbounded and
 * relative to the corpus, so an absolute floor is meaningless across projects.
 * The channel is capped by rank and RRF decides what survives.
 */
const LEXICAL_SEARCH_MULTI = `
  CALL db.index.fulltext.queryNodes('code_fts_idx', $luceneQuery) YIELD node, score
  WHERE node.projectId IN $projectIds
  WITH node, score
  LIMIT toInteger($limit)
  RETURN {
    id: node.id,
    labels: labels(node),
    properties: apoc.map.removeKeys(properties(node), ['embedding', 'contentHash', 'mtime', 'size'])
  } as node, score, node.projectId AS projectId
  ORDER BY score DESC
`;

/** Lucene classic-query-parser reserved characters. */
const LUCENE_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/** Lucene rejects a boolean query above 1024 clauses; stay well under it. */
const MAX_LEXICAL_TERMS = 32;

/** `name` is a far shorter field than `sourceCode`, and a hit there is a much
 *  stronger signal that the caller meant this exact symbol. */
const NAME_FIELD_BOOST = 3;

/** Reciprocal Rank Fusion constant from Cormack et al. 2009. */
export const RRF_K = 60;

/** Floor on per-channel candidates, so a small topK still gives RRF room. */
const MIN_CANDIDATE_POOL = 50;

export type SearchChannel = 'vector' | 'lexical';

export interface SearchCodeLexicalOptions {
  projectIds: string[];
  query: string;
  limit: number;
}

export interface SearchCodeHybridOptions {
  projectIds: string[];
  query: string;
  embedding: number[];
  limit: number;
  minSimilarity: number;
  fetchMultiplier?: number;
}

/**
 * A fused row. `score` is kept as the cosine score so it means the same thing
 * it means everywhere else, and is 0 for a node only the lexical channel found.
 * Rank on `fusedScore`; report `vectorScore` and `lexicalScore`.
 */
export interface FusedSearchRow extends SearchCodeRawRow {
  fusedScore: number;
  vectorScore: number | null;
  lexicalScore: number | null;
  channels: SearchChannel[];
}

/** A full-text field to search, and how much a hit in it counts against the others. */
export interface LuceneField {
  name: string;
  boost?: number;
}

const CODE_FIELDS: readonly LuceneField[] = [{ name: 'name', boost: NAME_FIELD_BOOST }, { name: 'sourceCode' }];

/**
 * Turn free text into a Lucene query over `fields`, or null when nothing searchable is left.
 *
 * Every reserved character is escaped, so a query like `what does foo() do?`
 * is matched literally instead of being parsed as grouping and wildcards.
 */
export const buildLuceneQuery = (raw: string, fields: readonly LuceneField[] = CODE_FIELDS): string | null => {
  const terms = raw
    .split(/\s+/)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, MAX_LEXICAL_TERMS)
    .map((term) => term.replace(LUCENE_SPECIAL_CHARS, '\\$&'));

  if (terms.length === 0) return null;

  const joined = terms.join(' ');
  return fields.map(({ name, boost }) => `${name}:(${joined})${boost ? `^${boost}` : ''}`).join(' OR ');
};

/**
 * Run the project-scoped BM25 search. Returns [] rather than throwing when the
 * index is absent, which is the state of any graph that has not restarted the
 * MCP server since the index was introduced.
 */
export const searchCodeLexical = async (
  neo4jService: Neo4jService,
  { projectIds, query, limit }: SearchCodeLexicalOptions,
): Promise<SearchCodeRawRow[]> => {
  const luceneQuery = buildLuceneQuery(query);
  if (luceneQuery === null) return [];

  try {
    const rows = await neo4jService.run(LEXICAL_SEARCH_MULTI, { luceneQuery, projectIds, limit });
    return rows as unknown as SearchCodeRawRow[];
  } catch (error) {
    await debugLog('Lexical channel unavailable, degrading to vector-only', error);
    return [];
  }
};

/**
 * Reciprocal Rank Fusion: each channel contributes 1/(k + rank) per node.
 *
 * Rank rather than raw score, because cosine is bounded 0..1 and BM25 is
 * unbounded and corpus-relative. The two are not on a common scale and cannot
 * be added or averaged; their orderings can.
 */
export const fuseRRF = (
  channels: { channel: SearchChannel; rows: SearchCodeRawRow[] }[],
  k: number = RRF_K,
): FusedSearchRow[] => {
  const fused = new Map<string, FusedSearchRow>();

  for (const { channel, rows } of channels) {
    rows.forEach((row, rank) => {
      const key = (row.node.properties.id as string | undefined) ?? row.node.id;
      const existing = fused.get(key);
      const target: FusedSearchRow = existing ?? {
        ...row,
        fusedScore: 0,
        vectorScore: null,
        lexicalScore: null,
        channels: [],
      };

      target.fusedScore += 1 / (k + rank + 1);
      target.channels.push(channel);
      if (channel === 'vector') target.vectorScore = row.score;
      else target.lexicalScore = row.score;

      if (existing === undefined) fused.set(key, target);
    });
  }

  return [...fused.values()]
    .map((row) => ({ ...row, score: row.vectorScore ?? 0 }))
    .sort((a, b) => b.fusedScore - a.fusedScore);
};

/**
 * Vector and BM25 in parallel, fused by reciprocal rank, cut to `limit`.
 *
 * Each channel is asked for a deeper pool than `limit` so fusion has something
 * to reorder; a node the vector channel ranked 8th can still win on the fused
 * score if BM25 ranked it 1st. That case is the reason this exists: cosine
 * scores for symbols sharing a name stem sit inside a band a fraction of a
 * point wide, which is not enough separation to pick the exact match.
 */
export const searchCodeHybrid = async (
  neo4jService: Neo4jService,
  { projectIds, query, embedding, limit, minSimilarity, fetchMultiplier = 10 }: SearchCodeHybridOptions,
): Promise<FusedSearchRow[]> => {
  const candidatePool = Math.max(limit * fetchMultiplier, MIN_CANDIDATE_POOL);

  const [vectorRows, lexicalRows] = await Promise.all([
    searchCodeRaw(neo4jService, {
      projectIds,
      embedding,
      limit: candidatePool,
      minSimilarity,
    }),
    searchCodeLexical(neo4jService, { projectIds, query, limit: candidatePool }),
  ]);

  return fuseRRF([
    { channel: 'vector', rows: vectorRows },
    { channel: 'lexical', rows: lexicalRows },
  ]).slice(0, limit);
};
