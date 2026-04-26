/**
 * Session Recall Tool
 * Unified tool merging restore_session_bookmark and recall_session_notes
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import {
  createEmptyResponse,
  createErrorResponse,
  createSuccessResponse,
  resolveProjectIdOrError,
  debugLog,
} from '../utils.js';

const NOTE_CATEGORIES = ['architectural', 'bug', 'insight', 'decision', 'risk', 'todo'] as const;
const NOTE_SEVERITIES = ['info', 'warning', 'critical'] as const;

/**
 * Neo4j query to find the most recent SessionBookmark matching filters
 */
const FIND_BOOKMARK_QUERY = `
  MATCH (b:SessionBookmark)
  WHERE b.projectId = $projectId
    AND ($sessionId IS NULL OR b.sessionId = $sessionId)
    AND ($agentId IS NULL OR b.agentId = $agentId)
  RETURN b.id AS id,
         b.projectId AS projectId,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.workingSetNodeIds AS workingSetNodeIds,
         b.taskContext AS taskContext,
         b.findings AS findings,
         b.nextSteps AS nextSteps,
         b.metadata AS metadata,
         b.createdAt AS createdAt,
         b.updatedAt AS updatedAt
  ORDER BY b.createdAt DESC
  LIMIT 1
`;

/**
 * Semantic (vector) search for SessionBookmarks.
 *
 * Used when `query` is provided AND `sessionId` is not — i.e. "find me the
 * bookmark from when I was working on X" without knowing which conversation.
 * Mirrors VECTOR_SEARCH_NOTES_QUERY shape; depends on the
 * session_bookmarks_idx vector index (Phase 1.5b).
 */
const VECTOR_SEARCH_BOOKMARKS_QUERY = `
  CALL db.index.vector.queryNodes('session_bookmarks_idx', toInteger($limit * 10), $queryEmbedding)
  YIELD node AS b, score
  WHERE b.projectId = $projectId
    AND ($agentId IS NULL OR b.agentId = $agentId)
    AND score >= $minSimilarity
  RETURN b.id AS id,
         b.projectId AS projectId,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.workingSetNodeIds AS workingSetNodeIds,
         b.taskContext AS taskContext,
         b.findings AS findings,
         b.nextSteps AS nextSteps,
         b.metadata AS metadata,
         b.createdAt AS createdAt,
         b.updatedAt AS updatedAt,
         score AS relevance
  ORDER BY score DESC, b.createdAt DESC
  LIMIT toInteger($limit)
`;

/**
 * Neo4j query to get code nodes referenced by a bookmark
 */
const GET_BOOKMARK_WORKING_SET_QUERY = `
  MATCH (b:SessionBookmark {id: $bookmarkId, projectId: $projectId})-[:REFERENCES]->(target)
  WHERE NOT target:Pheromone
    AND NOT target:SwarmTask
    AND NOT target:SessionBookmark
    AND NOT target:SessionNote
  RETURN target.id AS id,
         target.projectId AS projectId,
         labels(target)[0] AS type,
         target.name AS name,
         target.filePath AS filePath,
         CASE WHEN $includeCode THEN target.sourceCode ELSE null END AS sourceCode,
         target.coreType AS coreType,
         target.semanticType AS semanticType,
         target.startLine AS startLine,
         target.endLine AS endLine
  ORDER BY target.filePath, target.startLine
`;

/**
 * Semantic (vector) search for session notes.
 *
 * Returns top-K by vector similarity, then secondary-sorts by
 * lastValidated DESC and severity DESC so freshness and criticality
 * surface first when scores are close. Filters out notes whose
 * supersededBy is non-null unless includeSuperseded is true.
 */
const VECTOR_SEARCH_NOTES_QUERY = `
  CALL db.index.vector.queryNodes('session_notes_idx', toInteger($limit * 10), $queryEmbedding)
  YIELD node AS n, score
  WHERE n.projectId = $projectId
    AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
    AND ($category IS NULL OR n.category = $category)
    AND ($severity IS NULL OR n.severity = $severity)
    AND ($sessionId IS NULL OR n.sessionId = $sessionId)
    AND ($agentId IS NULL OR n.agentId = $agentId)
    AND ($includeSuperseded OR n.supersededBy IS NULL)
    AND score >= $minSimilarity

  OPTIONAL MATCH (n)-[:ABOUT]->(codeNode)
  WHERE NOT codeNode:SessionNote
    AND NOT codeNode:SessionBookmark
    AND NOT codeNode:Pheromone
    AND NOT codeNode:SwarmTask

  RETURN
    n.id AS id,
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
 * Filter-based (non-semantic) search for session notes.
 *
 * Used when no `query` is provided. Orders by lastValidated DESC then
 * createdAt DESC so freshly-revalidated old notes don't sink below
 * shallow new ones. Same supersededBy filter as the vector path.
 */
const FILTER_SEARCH_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId = $projectId
    AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
    AND ($category IS NULL OR n.category = $category)
    AND ($severity IS NULL OR n.severity = $severity)
    AND ($sessionId IS NULL OR n.sessionId = $sessionId)
    AND ($agentId IS NULL OR n.agentId = $agentId)
    AND ($includeSuperseded OR n.supersededBy IS NULL)

  OPTIONAL MATCH (n)-[:ABOUT]->(codeNode)
  WHERE NOT codeNode:SessionNote
    AND NOT codeNode:SessionBookmark
    AND NOT codeNode:Pheromone
    AND NOT codeNode:SwarmTask

  RETURN
    n.id AS id,
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
    null AS relevance,
    collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath}) AS aboutNodes

  ORDER BY coalesce(n.lastValidated, n.createdAt) DESC,
           n.createdAt DESC
  LIMIT toInteger($limit)
`;

export const createSessionRecallTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.sessionRecall,
    {
      title: TOOL_METADATA[TOOL_NAMES.sessionRecall].title,
      description: TOOL_METADATA[TOOL_NAMES.sessionRecall].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        sessionId: z.string().optional().describe('Session ID to restore (latest bookmark + all notes)'),
        agentId: z.string().optional().describe('Filter by agent ID'),
        query: z.string().optional().describe('Semantic search query for notes'),
        category: z.enum(NOTE_CATEGORIES).optional().describe('Filter notes by category'),
        severity: z.enum(NOTE_SEVERITIES).optional().describe('Filter notes by severity'),
        includeCode: z.boolean().optional().default(true).describe('Include source code for working set nodes'),
        snippetLength: z.number().int().optional().default(500).describe('Code snippet character limit'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(5)
          .describe('Maximum notes to return. Default 5 keeps recall context tight; pass 10+ when broader retrieval is needed.'),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.3)
          .describe('Minimum similarity for semantic search'),
        includeSuperseded: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When false (default), notes with non-null supersededBy are filtered out — recall returns only current notes. Set true to surface superseded history (e.g. for archaeology).',
          ),
      },
    },
    async ({
      projectId,
      sessionId,
      agentId,
      query,
      category,
      severity,
      includeCode = true,
      snippetLength = 500,
      limit = 5,
      minSimilarity = 0.3,
      includeSuperseded = false,
    }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        let bookmark: Record<string, unknown> | null = null;
        let workingSet: Record<string, unknown>[] = [];
        let staleNodeIds: string[] = [];

        // Embed the query once — reused for both bookmark and notes semantic search.
        let queryEmbedding: number[] | null = null;
        if (query) {
          const embeddingsService = new EmbeddingsService();
          queryEmbedding = await embeddingsService.embedText(query);
        }

        // Choose how to find the bookmark:
        //   sessionId provided    → latest bookmark for that session (resume / continue)
        //   else, queryEmbedding  → top semantic match across all bookmarks (Phase 1.5b)
        //   else                  → no bookmark
        let bookmarkRows: any[] = [];
        if (sessionId) {
          bookmarkRows = await neo4jService.run(FIND_BOOKMARK_QUERY, {
            projectId: resolvedProjectId,
            sessionId,
            agentId: agentId ?? null,
          });
        } else if (queryEmbedding) {
          bookmarkRows = await neo4jService.run(VECTOR_SEARCH_BOOKMARKS_QUERY, {
            projectId: resolvedProjectId,
            queryEmbedding,
            limit: 1,
            minSimilarity,
            agentId: agentId ?? null,
          });
        }

        if (bookmarkRows.length > 0) {
          const bm = bookmarkRows[0];

          const workingSetRows = await neo4jService.run(GET_BOOKMARK_WORKING_SET_QUERY, {
            bookmarkId: bm.id,
            projectId: resolvedProjectId,
            includeCode,
          });

          workingSet = workingSetRows.map((row: any) => {
            const node: Record<string, unknown> = {
              id: row.id,
              type: row.type,
              name: row.name,
              filePath: row.filePath,
              coreType: row.coreType,
              semanticType: row.semanticType,
              startLine:
                typeof row.startLine === 'object' && row.startLine?.toNumber
                  ? row.startLine.toNumber()
                  : row.startLine,
              endLine:
                typeof row.endLine === 'object' && row.endLine?.toNumber ? row.endLine.toNumber() : row.endLine,
            };

            if (includeCode && row.sourceCode) {
              const code: string = row.sourceCode;
              if (code.length <= snippetLength) {
                node.sourceCode = code;
              } else {
                const half = Math.floor(snippetLength / 2);
                node.sourceCode =
                  code.substring(0, half) + '\n\n... [truncated] ...\n\n' + code.substring(code.length - half);
                node.truncated = true;
              }
            }

            return node;
          });

          const foundIds = new Set(workingSetRows.map((r: any) => r.id));
          const storedIds: string[] = Array.isArray(bm.workingSetNodeIds) ? bm.workingSetNodeIds : [];
          staleNodeIds = storedIds.filter((id) => !foundIds.has(id));

          bookmark = {
            id: bm.id,
            projectId: resolvedProjectId,
            sessionId: bm.sessionId,
            agentId: bm.agentId,
            summary: bm.summary,
            taskContext: bm.taskContext,
            findings: bm.findings,
            nextSteps: bm.nextSteps,
            metadata: bm.metadata ? JSON.parse(bm.metadata) : null,
            // matchSource: how the bookmark was selected — useful for the agent to
            // distinguish "this is the bookmark from the current conversation" vs
            // "this is a historical bookmark surfaced via semantic search."
            matchSource: sessionId ? 'sessionId' : 'semantic',
            relevance: bm.relevance != null ? Math.round(bm.relevance * 1000) / 1000 : null,
            createdAt:
              typeof bm.createdAt === 'object' && bm.createdAt?.toNumber ? bm.createdAt.toNumber() : bm.createdAt,
            updatedAt:
              typeof bm.updatedAt === 'object' && bm.updatedAt?.toNumber ? bm.updatedAt.toNumber() : bm.updatedAt,
          };
        }

        // Fetch notes — semantic if query provided, filter-based otherwise
        let rawNotes: any[];

        if (queryEmbedding) {
          rawNotes = await neo4jService.run(VECTOR_SEARCH_NOTES_QUERY, {
            projectId: resolvedProjectId,
            queryEmbedding,
            limit: Math.floor(limit),
            minSimilarity,
            category: category ?? null,
            severity: severity ?? null,
            sessionId: sessionId ?? null,
            agentId: agentId ?? null,
            includeSuperseded,
          });
        } else {
          rawNotes = await neo4jService.run(FILTER_SEARCH_NOTES_QUERY, {
            projectId: resolvedProjectId,
            limit: Math.floor(limit),
            category: category ?? null,
            severity: severity ?? null,
            sessionId: sessionId ?? null,
            agentId: agentId ?? null,
            includeSuperseded,
          });
        }

        const toN = (v: any): number | null =>
          v == null ? null : typeof v === 'object' && v?.toNumber ? v.toNumber() : v;

        const notes = rawNotes.map((row: any) => {
          const createdAt = toN(row.createdAt);
          const expiresAt = toN(row.expiresAt);
          const lastValidated = toN(row.lastValidated);
          const aboutNodes = (row.aboutNodes ?? []).filter((n: any) => n?.id != null);

          // Compute staleAboutNodeIds — IDs persisted on the note that no
          // longer resolve to a current code node. Mirrors the bookmark
          // staleNodeIds pattern. Useful signal for the constitution's
          // staleness handling rule.
          const aboutNodeIds: string[] = Array.isArray(row.aboutNodeIds) ? row.aboutNodeIds : [];
          const foundIds = new Set<string>(aboutNodes.map((n: any) => n.id));
          const staleAboutNodeIds = aboutNodeIds.filter((id) => !foundIds.has(id));

          return {
            id: row.id,
            topic: row.topic,
            content: row.content,
            category: row.category,
            severity: row.severity,
            relevance: row.relevance != null ? Math.round(row.relevance * 1000) / 1000 : null,
            agentId: row.agentId,
            sessionId: row.sessionId,
            createdAt,
            expiresAt,
            lastValidated,
            supersededBy: row.supersededBy ?? null,
            aboutNodes,
            staleAboutNodeIds,
          };
        });

        const notesWithStaleRefs = notes.filter((n) => n.staleAboutNodeIds.length > 0).length;

        if (!bookmark && notes.length === 0) {
          return createEmptyResponse(
            sessionId
              ? `No bookmark or notes found for session "${sessionId}" in project ${resolvedProjectId}`
              : `No notes found for project ${resolvedProjectId}`,
            query
              ? 'Try a different query, or lower minSimilarity.'
              : 'Save notes or bookmarks with session_save.',
          );
        }

        return createSuccessResponse(
          JSON.stringify(
            {
              success: true,
              projectId: resolvedProjectId,
              searchMode: query ? 'semantic' : 'filter',
              includeSuperseded,
              bookmark,
              workingSet,
              staleNodeIds,
              notes,
              stats: {
                notesCount: notes.length,
                notesWithStaleRefs,
                workingSetFound: workingSet.length,
                workingSetStale: staleNodeIds.length,
              },
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await debugLog('Session recall error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
