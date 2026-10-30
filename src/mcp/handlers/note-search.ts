/**
 * Note recall by query: three channels find candidate notes, reciprocal-rank fusion merges them,
 * and a cross-encoder orders the merged list and drops what it scores as unrelated.
 *
 *   vector   nearest notes and note chunks by embedding
 *   keyword  BM25 over topic and content (session_notes_fts_idx)
 *   code     notes about the code the query finds: hybrid code search, then notes anchored to a
 *            node in one of the matched files, or naming that file in aboutPaths
 *
 * Measured on 48 labeled recall queries in docs/code-graph-context/research/recall-v2.md: keyword
 * search finds what embeddings miss, and the reranker separates relevant notes better than cosine.
 */

import { getNoteRerankFloor, isRerankEnabled } from '../../core/embeddings/embedding-config.js';
import { getEmbeddingSidecar } from '../../core/embeddings/embedding-sidecar.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import {
  NOTE_CANDIDATES_PER_PROJECT,
  nearestNeighborsPerRow,
  runProjectFilteredSearch,
} from '../../storage/neo4j/project-vector-search.js';
import { VECTOR_INDEXES } from '../../storage/neo4j/vector-indexes.js';
import { debugLog } from '../utils.js';

import { buildLuceneQuery, searchCodeHybrid } from './query-signals.handler.js';
import {
  NOTE_ABOUT_NODES_CLAUSE,
  NOTE_NOT_EXPIRED_CLAUSE,
  NOTE_NOT_SUPERSEDED_CLAUSE,
} from './session-note-query-clauses.js';

export type NoteChannel = 'vector' | 'keyword' | 'code';

/** Candidates each channel contributes, and the length of the fused list the reranker reads. */
const NOTE_POOL = 30;

/** Code matches whose files the code channel looks up notes for. */
const CODE_MATCHES = 20;

/** search_codebase's own default floor for the code vector channel: cosine 0. */
const CODE_MIN_SIMILARITY = 0.5;

/**
 * Fusion settings from a sweep over the labeled queries (recall-v2.md): with the reranker they barely
 * matter, and without it keyword matches deserve three times the vector channel's weight, because recall
 * queries are lists of the words a note uses. A small k lets rank 1 count for more than rank 10.
 */
const NOTE_RRF_K = 10;
const NOTE_CHANNEL_WEIGHTS: Record<NoteChannel, number> = { vector: 1, keyword: 3, code: 1 };

/** A cross-encoder reads about 512 tokens; the rest of a long note would be cut anyway. */
const RERANK_TEXT_CHARS = 2000;

export const NOTE_COLUMNS = `
    n.id AS id,
    n.projectId AS projectId,
    n.topic AS topic,
    n.content AS content,
    n.category AS category,
    n.severity AS severity,
    n.agentId AS agentId,
    n.sessionId AS sessionId,
    n.createdAt AS createdAt,
    n.expiresAt AS expiresAt,
    n.lastValidated AS lastValidated,
    n.supersededBy AS supersededBy,
    coalesce(n.aboutNodeIds, []) AS aboutNodeIds,
    coalesce(n.aboutPaths, []) AS aboutPaths,
    coalesce(n.aboutPathHashes, []) AS aboutPathHashes`;

export const ABOUT_NODES_COLUMN = `collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath, projectId: codeNode.projectId}) AS aboutNodes`;

/** Filters every note query applies; each parameter is null when the caller does not filter on it. */
export const NOTE_FILTERS = `
    ${NOTE_NOT_EXPIRED_CLAUSE}
    AND ($category IS NULL OR n.category = $category)
    AND ($severity IS NULL OR n.severity = $severity)
    AND ($sessionId IS NULL OR n.sessionId = $sessionId)
    AND ($agentId IS NULL OR n.agentId = $agentId)
    AND ($sinceMs IS NULL OR coalesce(n.lastValidated, n.createdAt) >= $sinceMs)
    AND ($includeSuperseded OR ${NOTE_NOT_SUPERSEDED_CLAUSE})`;

export interface NoteFilters {
  category: string | null;
  severity: string | null;
  sessionId: string | null;
  agentId: string | null;
  sinceMs: number | null;
  includeSuperseded: boolean;
}

export const NO_NOTE_FILTERS: NoteFilters = {
  category: null,
  severity: null,
  sessionId: null,
  agentId: null,
  sinceMs: null,
  includeSuperseded: false,
};

/** Scores each text against the query from 0 to 1, or null when no reranker is available. */
export type NoteReranker = (query: string, texts: string[]) => Promise<number[] | null>;

const sidecarReranker: NoteReranker = (query, texts) =>
  isRerankEnabled() ? getEmbeddingSidecar().rerank(query, texts) : Promise.resolve(null);

export interface NoteSearchOptions {
  projectIds: string[];
  /** The codebases among projectIds; the code channel searches only these. */
  codebaseProjectIds: string[];
  query: string;
  queryEmbedding: number[];
  limit: number;
  /** Floor on the (1 + cosine) / 2 scale for notes only the vector channel found. */
  minSimilarity: number;
  /** The caller chose minSimilarity, so it replaces the reranker's floor. */
  minSimilarityRequested: boolean;
  filters: NoteFilters;
  rerank?: NoteReranker;
}

/** A note row with NOTE_COLUMNS and aboutNodes, plus how the search found and scored it. */
export interface NoteSearchRow extends Record<string, unknown> {
  id: string;
  /** Vector similarity on the (1 + cosine) / 2 scale; null when only keyword or code found the note. */
  relevance: number | null;
  /** Cross-encoder score from 0 to 1; null when no reranker ran. */
  rerankScore: number | null;
  matchedBy: NoteChannel[];
}

interface Candidate {
  id: string;
  fusedScore: number;
  vectorScore: number | null;
  channels: NoteChannel[];
}

const notePool = (index: typeof VECTOR_INDEXES.sessionNotes | typeof VECTOR_INDEXES.sessionNoteChunks, node: string) =>
  nearestNeighborsPerRow({
    index,
    node,
    score: 'score',
    queryVector: '$queryEmbedding',
    neighbors: String(NOTE_CANDIDATES_PER_PROJECT),
    projectIds: '$projectIds',
    outerVariables: [],
  });

// Return the parent once, using its strongest direct or chunk match.
export const VECTOR_NOTE_CANDIDATES_QUERY = `CYPHER 25
  CALL () {
    ${notePool(VECTOR_INDEXES.sessionNotes, 'note')}
    RETURN note AS n, score
    UNION ALL
    ${notePool(VECTOR_INDEXES.sessionNoteChunks, 'chunk')}
    MATCH (chunk)-[:PART_OF]->(parent:SessionNote)
    RETURN parent AS n, score
  }
  WITH n, max(score) AS score
  WHERE ${NOTE_FILTERS}
  RETURN n.id AS id, score
  ORDER BY score DESC, n.lastValidated DESC
  LIMIT toInteger($pool)
`;

export const KEYWORD_NOTE_CANDIDATES_QUERY = `
  CALL db.index.fulltext.queryNodes('session_notes_fts_idx', $luceneQuery) YIELD node AS n, score
  WHERE n.projectId IN $projectIds
    AND ${NOTE_FILTERS}
  RETURN n.id AS id, score
  ORDER BY score DESC
  LIMIT toInteger($pool)
`;

// A note's rank is that of the best-ranked matched file it is anchored to.
export const CODE_NOTE_CANDIDATES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId IN $projectIds
    AND ${NOTE_FILTERS}
  OPTIONAL MATCH (n)-[:ABOUT]->(anchor)
  WITH n, collect(anchor.filePath) + coalesce(n.aboutPaths, []) AS anchorFiles
  WITH n, [rank IN range(0, size($files) - 1) WHERE $files[rank] IN anchorFiles] AS ranks
  WHERE size(ranks) > 0
  RETURN n.id AS id, ranks[0] AS rank
  ORDER BY rank, n.lastValidated DESC
  LIMIT toInteger($pool)
`;

export const NOTE_ROWS_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.id IN $ids
  ${NOTE_ABOUT_NODES_CLAUSE}
  RETURN ${NOTE_COLUMNS},
    ${ABOUT_NODES_COLUMN}
`;

const NOTE_TOPIC_BOOST = 2;

type RunOnly = Pick<Neo4jService, 'run'>;

const filterParams = (filters: NoteFilters) => ({ ...filters, pool: NOTE_POOL });

const vectorCandidates = async (
  neo4jService: RunOnly,
  { projectIds, queryEmbedding, filters }: NoteSearchOptions,
): Promise<{ id: string; score: number }[]> =>
  (await runProjectFilteredSearch(neo4jService, VECTOR_INDEXES.sessionNotes, VECTOR_NOTE_CANDIDATES_QUERY, {
    projectIds,
    queryEmbedding,
    ...filterParams(filters),
  })) as { id: string; score: number }[];

/** Returns [] when the index is missing, the state of any graph whose server has not restarted since it was added. */
const keywordCandidates = async (
  neo4jService: RunOnly,
  { projectIds, query, filters }: NoteSearchOptions,
): Promise<string[]> => {
  const luceneQuery = buildLuceneQuery(query, [{ name: 'topic', boost: NOTE_TOPIC_BOOST }, { name: 'content' }]);
  if (luceneQuery === null) return [];
  try {
    const rows = await neo4jService.run(KEYWORD_NOTE_CANDIDATES_QUERY, {
      projectIds,
      luceneQuery,
      ...filterParams(filters),
    });
    return rows.map((row) => row.id as string);
  } catch (error) {
    await debugLog('Note keyword channel unavailable, continuing without it', error);
    return [];
  }
};

const codeCandidates = async (
  neo4jService: Neo4jService,
  { projectIds, codebaseProjectIds, query, queryEmbedding, filters }: NoteSearchOptions,
): Promise<string[]> => {
  if (codebaseProjectIds.length === 0) return [];
  const matches = await searchCodeHybrid(neo4jService, {
    projectIds: codebaseProjectIds,
    query,
    embedding: queryEmbedding,
    limit: CODE_MATCHES,
    minSimilarity: CODE_MIN_SIMILARITY,
    fetchMultiplier: 3,
  });
  const files = [
    ...new Set(
      matches
        .map((match) => match.node.properties.filePath)
        .filter((filePath): filePath is string => typeof filePath === 'string'),
    ),
  ];
  if (files.length === 0) return [];
  const rows = await neo4jService.run(CODE_NOTE_CANDIDATES_QUERY, { projectIds, files, ...filterParams(filters) });
  return rows.map((row) => row.id as string);
};

/** Weighted reciprocal-rank fusion: each channel adds weight / (k + rank), because cosine, BM25 and file rank share no scale. */
export const fuseNoteChannels = (
  channels: { channel: NoteChannel; ids: string[]; scores?: Map<string, number> }[],
  k: number = NOTE_RRF_K,
  weights: Record<NoteChannel, number> = NOTE_CHANNEL_WEIGHTS,
): Candidate[] => {
  const fused = new Map<string, Candidate>();
  for (const { channel, ids, scores } of channels) {
    ids.forEach((id, rank) => {
      const candidate = fused.get(id) ?? { id, fusedScore: 0, vectorScore: null, channels: [] };
      candidate.fusedScore += weights[channel] / (k + rank + 1);
      candidate.channels.push(channel);
      if (channel === 'vector') candidate.vectorScore = scores?.get(id) ?? null;
      fused.set(id, candidate);
    });
  }
  return [...fused.values()].sort((a, b) => b.fusedScore - a.fusedScore);
};

/**
 * Orders and cuts the fused candidates. With reranker scores, the reranker orders them, and recall
 * returns nothing when even the best scores under the calibrated floor; otherwise the top `limit` stand,
 * because the reranker scores a note low when it mentions the fact only in passing. That holds unless
 * the caller set minSimilarity. Without scores, or when the caller
 * set minSimilarity, a note only the vector channel found must reach minSimilarity; a keyword or code
 * match is kept on its rank, because BM25 and file rank have no comparable floor.
 */
export const rankNoteCandidates = <C extends Candidate>(
  candidates: C[],
  scores: number[] | null,
  {
    minSimilarity,
    minSimilarityRequested,
    limit,
  }: Pick<NoteSearchOptions, 'minSimilarity' | 'minSimilarityRequested' | 'limit'>,
  rerankFloor: number,
): (C & { rerankScore: number | null })[] => {
  const passesVectorFloor = (candidate: C) =>
    candidate.channels.some((channel) => channel !== 'vector') || (candidate.vectorScore ?? 0) >= minSimilarity;
  if (!scores) {
    return candidates
      .map((candidate) => ({ ...candidate, rerankScore: null }))
      .filter(passesVectorFloor)
      .slice(0, limit);
  }
  const reranked = candidates
    .map((candidate, i) => ({ ...candidate, rerankScore: scores[i] }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
  if (minSimilarityRequested) return reranked.filter(passesVectorFloor).slice(0, limit);
  return (reranked[0]?.rerankScore ?? 0) >= rerankFloor ? reranked.slice(0, limit) : [];
};

export const searchSessionNotes = async (
  neo4jService: Neo4jService,
  options: NoteSearchOptions,
): Promise<NoteSearchRow[]> => {
  const [vector, keyword, code] = await Promise.all([
    vectorCandidates(neo4jService, options),
    keywordCandidates(neo4jService, options),
    codeCandidates(neo4jService, options).catch(async (error) => {
      await debugLog('Note code channel failed, continuing without it', error);
      return [] as string[];
    }),
  ]);

  const candidates = fuseNoteChannels([
    { channel: 'vector', ids: vector.map((row) => row.id), scores: new Map(vector.map((row) => [row.id, row.score])) },
    { channel: 'keyword', ids: keyword },
    { channel: 'code', ids: code },
  ]).slice(0, NOTE_POOL);
  if (candidates.length === 0) return [];

  const rows: Record<string, unknown>[] = await neo4jService.run(NOTE_ROWS_QUERY, {
    ids: candidates.map((candidate) => candidate.id),
  });
  const rowsById = new Map(rows.map((row) => [row.id as string, row]));
  const found = candidates.flatMap((candidate) => {
    const row = rowsById.get(candidate.id);
    return row ? [{ ...candidate, row }] : [];
  });

  const rerank = options.rerank ?? sidecarReranker;
  const scores = await rerank(
    options.query,
    found.map(({ row }) => `${String(row.topic ?? '')}\n${String(row.content ?? '')}`.slice(0, RERANK_TEXT_CHARS)),
  );

  return rankNoteCandidates(found, scores, options, getNoteRerankFloor()).map((candidate) => ({
    ...candidate.row,
    id: candidate.id,
    relevance: candidate.vectorScore,
    rerankScore: candidate.rerankScore,
    matchedBy: candidate.channels,
  }));
};
