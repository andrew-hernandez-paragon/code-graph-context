/**
 * Query Signals Tool — sectioned UNION across code, notes, pheromones.
 *
 * One MCP tool call → fans out (via Promise.all) to:
 *   - code:       searchCodeRaw      → VECTOR_SEARCH_MULTI Cypher (multi-projectId)
 *   - notes:      VECTOR_SEARCH_NOTES Cypher (per session-recall.tool.ts)
 *   - pheromones: SENSE_PHEROMONES   Cypher (per swarm-sense.tool.ts)
 *
 * Returns sectioned per-source results, NOT a fused list. Each section is
 * ranked by that source's native score. v1 cuts: no toolcalls (0001), no
 * commits (0003), no pagination, no learned ranker, no embedding cache.
 *
 * 0008 — sidecar fast-fail:
 *   probeEmbeddingsHealth() fires before the embedder. On probe failure:
 *   - code section → skipped: 'embedding-provider-unavailable', results: []
 *   - notes section → Cypher-only fallback (recent notes, no semantic ranking),
 *     skipped: 'semantic-ranking-unavailable'
 *   - pheromones section → unaffected (no embedder dependency)
 *
 * 0013 — multi-projectId:
 *   Accept projectId (single, backwards-compat) OR projectIds (array).
 *   groupBy: 'source' (default) — today's shape, results per section span
 *     projects, each result has a projectId field.
 *   groupBy: 'project' — top-level keyed by projectId; empty projects included
 *     with count:0 for shape stability.
 *   Concurrency gate: pLimit(8) equivalent via a lightweight semaphore so the
 *     Neo4j connection pool is not exhausted under large projectIds arrays.
 *
 * `since` semantic — applies only to time-aware sources:
 *   - code section is annotated skipped: 'time-filter-not-applicable'
 *   - notes section filters by lastValidated >= since
 *   - pheromones section ignores since (intensity decay handles freshness)
 *
 * Pheromones source — returns all active pheromones ranked by current
 * intensity, ignoring the query string (pheromones aren't vector-indexed).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { projectCodeResult, probeEmbeddingsHealth, searchCodeRaw } from '../handlers/query-signals.handler.js';
import { createErrorResponse, createSuccessResponse, debugLog, resolveProjectIdOrError } from '../utils.js';

// ---------------------------------------------------------------------------
// Cypher — notes (copied from session-recall.tool.ts, multi-projectId)
// ---------------------------------------------------------------------------

/**
 * Notes Cypher: optional sinceMs filter on lastValidated/createdAt.
 * Keeps the supersededBy filter and expiresAt freshness filter.
 * 0013: uses IN $projectIds for multi-project support.
 */
const VECTOR_SEARCH_NOTES_FOR_SIGNALS = `
  CALL db.index.vector.queryNodes('session_notes_idx', toInteger($limit * 10), $queryEmbedding)
  YIELD node AS n, score
  WHERE n.projectId IN $projectIds
    AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
    AND ($sinceMs IS NULL OR coalesce(n.lastValidated, n.createdAt) >= $sinceMs)
    AND n.supersededBy IS NULL
    AND score >= $minSimilarity

  OPTIONAL MATCH (n)-[:ABOUT]->(codeNode)
  WHERE NOT codeNode:SessionNote
    AND NOT codeNode:SessionBookmark
    AND NOT codeNode:Pheromone
    AND NOT codeNode:SwarmTask

  RETURN
    n.id AS id,
    n.projectId AS projectId,
    n.topic AS topic,
    n.content AS content,
    n.category AS category,
    n.severity AS severity,
    n.lastValidated AS lastValidated,
    n.createdAt AS createdAt,
    coalesce(n.aboutNodeIds, []) AS aboutNodeIds,
    score AS relevance,
    collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath}) AS aboutNodes

  ORDER BY score DESC,
           n.lastValidated DESC,
           CASE n.severity
             WHEN 'critical' THEN 0
             WHEN 'warning'  THEN 1
             ELSE 2
           END
  LIMIT toInteger($limit)
`;

/**
 * Cypher-only fallback for notes when embedder is unavailable (0008).
 * Returns recent non-superseded notes sorted by lastValidated DESC.
 */
const RECENT_NOTES_FOR_SIGNALS = `
  MATCH (n:SessionNote)
  WHERE n.projectId IN $projectIds
    AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
    AND ($sinceMs IS NULL OR coalesce(n.lastValidated, n.createdAt) >= $sinceMs)
    AND n.supersededBy IS NULL

  OPTIONAL MATCH (n)-[:ABOUT]->(codeNode)
  WHERE NOT codeNode:SessionNote
    AND NOT codeNode:SessionBookmark
    AND NOT codeNode:Pheromone
    AND NOT codeNode:SwarmTask

  RETURN
    n.id AS id,
    n.projectId AS projectId,
    n.topic AS topic,
    n.content AS content,
    n.category AS category,
    n.severity AS severity,
    n.lastValidated AS lastValidated,
    n.createdAt AS createdAt,
    coalesce(n.aboutNodeIds, []) AS aboutNodeIds,
    null AS relevance,
    collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath}) AS aboutNodes

  ORDER BY n.lastValidated DESC,
           CASE n.severity
             WHEN 'critical' THEN 0
             WHEN 'warning'  THEN 1
             ELSE 2
           END
  LIMIT toInteger($limit)
`;

// ---------------------------------------------------------------------------
// Cypher — pheromones (copied from swarm-sense.tool.ts, multi-projectId)
// ---------------------------------------------------------------------------

/**
 * Returns ALL active pheromones in the given projects ranked by current
 * intensity. Query string is ignored — pheromones aren't vector-indexed.
 * 0013: uses IN $projectIds.
 */
const SENSE_PHEROMONES_FOR_SIGNALS = `
  MATCH (p:Pheromone)
  WHERE p.projectId IN $projectIds
  WITH p,
    CASE
      WHEN p.halfLife IS NULL OR p.halfLife <= 0 THEN p.intensity
      ELSE p.intensity * exp(-0.693147 * (timestamp() - p.timestamp) / p.halfLife)
    END AS currentIntensity
  WHERE currentIntensity >= $minIntensity

  OPTIONAL MATCH (target)
  WHERE target.id = p.nodeId AND target.projectId = p.projectId

  RETURN
    p.id AS id,
    p.projectId AS projectId,
    p.nodeId AS nodeId,
    p.type AS type,
    p.intensity AS originalIntensity,
    currentIntensity,
    p.agentId AS agentId,
    p.swarmId AS swarmId,
    p.timestamp AS timestamp,
    p.data AS data,
    CASE WHEN target IS NOT NULL THEN labels(target)[0] ELSE null END AS targetType,
    CASE WHEN target IS NOT NULL THEN target.name ELSE null END AS targetName,
    CASE WHEN target IS NOT NULL THEN target.filePath ELSE null END AS targetFilePath

  ORDER BY currentIntensity DESC, p.timestamp DESC
  LIMIT toInteger($limit)
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCES = ['code', 'notes', 'pheromones'] as const;
type Source = (typeof SOURCES)[number];

interface Neo4jInteger {
  toNumber(): number;
}

const isNeo4jInteger = (v: unknown): v is Neo4jInteger =>
  typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as Neo4jInteger).toNumber === 'function';

const toN = (v: unknown): number | null => (v == null ? null : isNeo4jInteger(v) ? v.toNumber() : (v as number));

/**
 * Parse `since` — accepts ISO duration like "30d", "7d", "12h", or epoch-ms.
 * Returns absolute epoch ms (filter floor), or null if unparseable / not provided.
 */
const parseSinceMs = (since?: string): number | null => {
  if (!since) return null;
  const m = /^(\d+)(d|h|m)$/i.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'd' ? n * 86_400_000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
    return Date.now() - ms;
  }
  const asNum = Number(since);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  return null;
};

const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/**
 * Lightweight Promise semaphore — pLimit(maxConcurrent) equivalent.
 * Bounds Neo4j connection pool usage when projectIds is large.
 */
const makeSemaphore = (maxConcurrent: number) => {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < maxConcurrent) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) {
        active++;
        next();
      }
    }
  };
};

// ---------------------------------------------------------------------------
// Section result types
// ---------------------------------------------------------------------------

interface CodeSection {
  results: ReturnType<typeof projectCodeResult>[];
  count: number;
  skipped?: string;
}

interface NoteResult {
  type: 'SessionNote';
  id: string;
  projectId: string;
  topic: string | null;
  content: string | null;
  category: string | null;
  severity: string | null;
  relevance: number | null;
  lastValidated: number | null;
  createdAt: number | null;
  aboutNodes: Array<{ id: string; name: string | null; filePath: string | null }>;
  aboutNodeIds: string[];
}

interface NotesSection {
  results: NoteResult[];
  count: number;
  skipped?: string;
}

interface PheromoneResult {
  type: 'Pheromone';
  id: string;
  projectId: string;
  pheromoneType: string;
  intensity: number;
  originalIntensity: number;
  agentId: string | null;
  swarmId: string | null;
  timestamp: number | null;
  age: string | null;
  data: unknown;
  target: { type: string; name: string | null; filePath: string | null } | null;
}

interface PheromonesSection {
  results: PheromoneResult[];
  count: number;
  skipped?: string;
}

// ---------------------------------------------------------------------------
// QuerySignals input / output types
// ---------------------------------------------------------------------------

export interface QuerySignalsInput {
  projectIds: string[];
  query: string;
  sources?: Source[];
  limitPerSource?: number;
  since?: string;
  minSimilarity?: number;
  minIntensity?: number;
  groupBy?: 'source' | 'project';
}

interface SourcesSection {
  code: CodeSection;
  notes: NotesSection;
  pheromones: PheromonesSection;
}

interface PerProjectSources {
  sources: SourcesSection;
  totalCount: number;
}

interface Stats {
  sourceLatencyMs: { code: number | null; notes: number | null; pheromones: number | null };
  totalLatencyMs: number;
}

export interface QuerySignalsBySourceResponse {
  projectIds: string[];
  query: string;
  sources: SourcesSection;
  stats: Stats;
  unresolvedProjectIds?: string[];
}

export interface QuerySignalsByProjectResponse {
  projectIds: string[];
  query: string;
  projects: Record<string, PerProjectSources>;
  stats: Stats;
  unresolvedProjectIds?: string[];
}

export type QuerySignalsResponse = QuerySignalsBySourceResponse | QuerySignalsByProjectResponse;

// ---------------------------------------------------------------------------
// pivotToProjectGroup (0013)
// ---------------------------------------------------------------------------

/**
 * Transform a groupBy:'source' response into groupBy:'project' shape.
 * Each result has a `projectId` field — group by it, then re-section.
 * Empty projects (projectId in the resolved list but no results) are included
 * with count:0 for shape stability.
 */
const pivotToProjectGroup = (
  resolvedProjectIds: string[],
  sources: SourcesSection,
): Record<string, PerProjectSources> => {
  const out: Record<string, PerProjectSources> = {};

  // Initialize all projects with empty sections
  for (const pid of resolvedProjectIds) {
    out[pid] = {
      sources: {
        code: { results: [], count: 0, ...(sources.code.skipped ? { skipped: sources.code.skipped } : {}) },
        notes: { results: [], count: 0, ...(sources.notes.skipped ? { skipped: sources.notes.skipped } : {}) },
        pheromones: {
          results: [],
          count: 0,
          ...(sources.pheromones.skipped ? { skipped: sources.pheromones.skipped } : {}),
        },
      },
      totalCount: 0,
    };
  }

  // Distribute code results
  for (const r of sources.code.results) {
    const bucket = out[r.projectId];
    if (bucket) {
      bucket.sources.code.results.push(r);
      bucket.sources.code.count++;
      bucket.totalCount++;
    }
  }

  // Distribute notes results
  for (const r of sources.notes.results) {
    const bucket = out[r.projectId];
    if (bucket) {
      bucket.sources.notes.results.push(r);
      bucket.sources.notes.count++;
      bucket.totalCount++;
    }
  }

  // Distribute pheromone results
  for (const r of sources.pheromones.results) {
    const bucket = out[r.projectId];
    if (bucket) {
      bucket.sources.pheromones.results.push(r);
      bucket.sources.pheromones.count++;
      bucket.totalCount++;
    }
  }

  return out;
};

// ---------------------------------------------------------------------------
// runQuerySignals — core handler
// ---------------------------------------------------------------------------

/**
 * Core handler — directly callable by the MCP tool wrapper.
 * Accepts pre-resolved projectIds (resolution/error-partitioning happens in
 * the MCP wrapper). Caller is responsible for closing the Neo4j service.
 */
export const runQuerySignals = async (
  neo4jService: Neo4jService,
  input: QuerySignalsInput,
): Promise<QuerySignalsResponse> => {
  const {
    projectIds,
    query,
    sources = ['code', 'notes', 'pheromones'],
    limitPerSource = 5,
    since,
    minSimilarity = 0.5,
    minIntensity = 0.3,
    groupBy = 'source',
  } = input;

  const sinceMs = parseSinceMs(since);
  const t0 = Date.now();

  const includeCode = sources.includes('code');
  const includeNotes = sources.includes('notes');
  const includePheromones = sources.includes('pheromones');

  // 0008: Fast-fail probe — avoids the 120s sidecar startup wedge.
  const embeddingsHealthy = includeCode || includeNotes ? await probeEmbeddingsHealth(100) : false;

  // Embed once (only if any vector source is requested AND embedder is healthy)
  let embedding: number[] | null = null;
  if ((includeCode || includeNotes) && embeddingsHealthy) {
    const embeddingsService = new EmbeddingsService();
    embedding = await embeddingsService.embedText(query);
  }

  const latencies: { code: number | null; notes: number | null; pheromones: number | null } = {
    code: null,
    notes: null,
    pheromones: null,
  };

  // ---
  // Code section
  // ---
  const codePromise = (async (): Promise<CodeSection> => {
    if (!includeCode) return { results: [], count: 0 };
    if (!embeddingsHealthy) return { results: [], count: 0, skipped: 'embedding-provider-unavailable' };
    if (!embedding) return { results: [], count: 0, skipped: 'embedding-provider-unavailable' };

    const tStart = Date.now();
    const rows = await searchCodeRaw(neo4jService, {
      projectIds,
      embedding,
      limit: limitPerSource,
      minSimilarity,
    });
    latencies.code = Date.now() - tStart;
    const results = rows.map((r) => projectCodeResult(r));
    return {
      results,
      count: results.length,
      ...(sinceMs != null ? { skipped: 'time-filter-not-applicable' } : {}),
    };
  })();

  // ---
  // Notes section
  // ---
  const notesPromise = (async (): Promise<NotesSection> => {
    if (!includeNotes) return { results: [], count: 0 };

    const tStart = Date.now();

    // 0008: if embedder unavailable, fall back to Cypher-only (recent notes)
    const cypherQuery = embeddingsHealthy && embedding ? VECTOR_SEARCH_NOTES_FOR_SIGNALS : RECENT_NOTES_FOR_SIGNALS;
    const params: Record<string, unknown> = {
      projectIds,
      limit: Math.floor(limitPerSource),
      sinceMs,
      ...(embeddingsHealthy && embedding ? { queryEmbedding: embedding, minSimilarity } : {}),
    };

    const rows = await neo4jService.run(cypherQuery, params);
    latencies.notes = Date.now() - tStart;

    const results: NoteResult[] = rows.map((row: Record<string, unknown>) => ({
      type: 'SessionNote' as const,
      id: row.id as string,
      projectId: row.projectId as string,
      topic: (row.topic as string) ?? null,
      content: (row.content as string) ?? null,
      category: (row.category as string) ?? null,
      severity: (row.severity as string) ?? null,
      relevance: row.relevance != null ? Math.round((row.relevance as number) * 1000) / 1000 : null,
      lastValidated: toN(row.lastValidated),
      createdAt: toN(row.createdAt),
      aboutNodes: ((row.aboutNodes as Array<{ id?: string; name?: string; filePath?: string } | null>) ?? [])
        .filter((n): n is { id: string; name?: string; filePath?: string } => n?.id != null)
        .map((n) => ({ id: n.id, name: n.name ?? null, filePath: n.filePath ?? null })),
      aboutNodeIds: Array.isArray(row.aboutNodeIds) ? (row.aboutNodeIds as string[]) : [],
    }));

    return {
      results,
      count: results.length,
      ...(!embeddingsHealthy ? { skipped: 'semantic-ranking-unavailable' } : {}),
    };
  })();

  // ---
  // Pheromones section
  // ---
  const pheromonesPromise = (async (): Promise<PheromonesSection> => {
    if (!includePheromones) return { results: [], count: 0 };

    const tStart = Date.now();
    const rows = await neo4jService.run(SENSE_PHEROMONES_FOR_SIGNALS, {
      projectIds,
      minIntensity,
      limit: Math.floor(limitPerSource),
    });
    latencies.pheromones = Date.now() - tStart;

    const results: PheromoneResult[] = rows.map((p: Record<string, unknown>) => {
      const ts = toN(p.timestamp);
      return {
        type: 'Pheromone' as const,
        id: p.id as string,
        projectId: p.projectId as string,
        pheromoneType: p.type as string,
        intensity: Math.round((p.currentIntensity as number) * 1000) / 1000,
        originalIntensity: p.originalIntensity as number,
        agentId: (p.agentId as string) ?? null,
        swarmId: (p.swarmId as string) ?? null,
        timestamp: ts,
        age: ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : null,
        data: p.data ? safeJsonParse(p.data as string) : null,
        target:
          p.targetType != null
            ? {
                type: p.targetType as string,
                name: (p.targetName as string) ?? null,
                filePath: (p.targetFilePath as string) ?? null,
              }
            : null,
      };
    });

    return {
      results,
      count: results.length,
      ...(sinceMs != null ? { skipped: 'time-filter-not-applicable' } : {}),
    };
  })();

  const [code, notes, pheromones] = await Promise.all([codePromise, notesPromise, pheromonesPromise]);

  const allSources: SourcesSection = { code, notes, pheromones };
  const stats: Stats = {
    sourceLatencyMs: latencies,
    totalLatencyMs: Date.now() - t0,
  };

  if (groupBy === 'project') {
    const projects = pivotToProjectGroup(projectIds, allSources);
    return { projectIds, query, projects, stats };
  }

  return { projectIds, query, sources: allSources, stats };
};

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export const createQuerySignalsTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.querySignals,
    {
      title: TOOL_METADATA[TOOL_NAMES.querySignals].title,
      description: TOOL_METADATA[TOOL_NAMES.querySignals].description,
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Project ID, name, or path (single-project shorthand; use projectIds for multi-project)'),
        projectIds: z
          .array(z.string())
          .min(1)
          .max(25)
          .optional()
          .describe(
            'Array of project IDs/names/paths (preferred; max 25). Use instead of projectId for multi-project.',
          ),
        query: z.string().describe('Natural language query — embedded once and used for code + notes vector sources'),
        sources: z
          .array(z.enum(SOURCES as unknown as [Source, ...Source[]]))
          .optional()
          .describe("Subset of sources to query. Default: ['code','notes','pheromones']"),
        limitPerSource: z.number().int().min(1).max(50).optional().default(5).describe('Top-K per source'),
        groupBy: z
          .enum(['source', 'project'])
          .optional()
          .default('source')
          .describe(
            "Response shape: 'source' (default) — sections at top level, each result has projectId field; 'project' — keyed by projectId at top level",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "ISO duration (e.g. '30d', '12h') or epoch ms. Applies only to notes; code & pheromones return skipped:'time-filter-not-applicable'.",
          ),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.5)
          .describe('Minimum cosine similarity for vector sources (code, notes)'),
        minIntensity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.3)
          .describe('Minimum effective pheromone intensity after decay'),
      },
    },
    async (input) => {
      const neo4jService = new Neo4jService();
      try {
        // Validate: exactly one of projectId / projectIds must be set
        if (!input.projectId && (!input.projectIds || input.projectIds.length === 0)) {
          return createErrorResponse('Provide projectId (single) or projectIds (array, min 1)');
        }

        // Normalize to array
        const rawIds: string[] =
          input.projectIds && input.projectIds.length > 0 ? input.projectIds : [input.projectId!];

        // Resolve all projectIds in parallel; partition into resolved / unresolved
        const resolutions = await Promise.all(
          rawIds.map((pid) => resolveProjectIdOrError(pid, neo4jService).then((r) => ({ pid, result: r }))),
        );

        const resolvedProjectIds: string[] = [];
        const unresolvedProjectIds: string[] = [];
        for (const { pid, result } of resolutions) {
          if (result.success) {
            resolvedProjectIds.push(result.projectId);
          } else {
            unresolvedProjectIds.push(pid);
          }
        }

        if (resolvedProjectIds.length === 0) {
          return createErrorResponse(`No resolvable projectIds. Unresolved: ${unresolvedProjectIds.join(', ')}`);
        }

        const concurrency = makeSemaphore(8);
        const response = await concurrency(() =>
          runQuerySignals(neo4jService, {
            projectIds: resolvedProjectIds,
            query: input.query,
            sources: input.sources as Source[] | undefined,
            limitPerSource: input.limitPerSource,
            since: input.since,
            minSimilarity: input.minSimilarity,
            minIntensity: input.minIntensity,
            groupBy: input.groupBy as 'source' | 'project' | undefined,
          }),
        );

        const payload: QuerySignalsResponse & { unresolvedProjectIds?: string[] } = response;
        if (unresolvedProjectIds.length > 0) {
          payload.unresolvedProjectIds = unresolvedProjectIds;
        }

        return createSuccessResponse(JSON.stringify(payload, null, 2));
      } catch (error) {
        await debugLog('Query signals error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
