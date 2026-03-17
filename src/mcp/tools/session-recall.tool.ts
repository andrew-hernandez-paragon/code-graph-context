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
 * Semantic (vector) search for session notes
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
    score AS relevance,
    collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath}) AS aboutNodes

  ORDER BY score DESC
  LIMIT toInteger($limit)
`;

/**
 * Filter-based (non-semantic) search for session notes
 */
const FILTER_SEARCH_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId = $projectId
    AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
    AND ($category IS NULL OR n.category = $category)
    AND ($severity IS NULL OR n.severity = $severity)
    AND ($sessionId IS NULL OR n.sessionId = $sessionId)
    AND ($agentId IS NULL OR n.agentId = $agentId)

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
    null AS relevance,
    collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath}) AS aboutNodes

  ORDER BY n.createdAt DESC
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
        limit: z.number().int().min(1).max(50).optional().default(10).describe('Maximum notes to return'),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.3)
          .describe('Minimum similarity for semantic search'),
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
      limit = 10,
      minSimilarity = 0.3,
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

        // If sessionId provided, fetch the latest bookmark and its working set
        if (sessionId) {
          const bookmarkRows = await neo4jService.run(FIND_BOOKMARK_QUERY, {
            projectId: resolvedProjectId,
            sessionId,
            agentId: agentId ?? null,
          });

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
              createdAt:
                typeof bm.createdAt === 'object' && bm.createdAt?.toNumber ? bm.createdAt.toNumber() : bm.createdAt,
              updatedAt:
                typeof bm.updatedAt === 'object' && bm.updatedAt?.toNumber ? bm.updatedAt.toNumber() : bm.updatedAt,
            };
          }
        }

        // Fetch notes — semantic if query provided, filter-based otherwise
        let rawNotes: any[];

        if (query) {
          const embeddingsService = new EmbeddingsService();
          const queryEmbedding = await embeddingsService.embedText(query);

          rawNotes = await neo4jService.run(VECTOR_SEARCH_NOTES_QUERY, {
            projectId: resolvedProjectId,
            queryEmbedding,
            limit: Math.floor(limit),
            minSimilarity,
            category: category ?? null,
            severity: severity ?? null,
            sessionId: sessionId ?? null,
            agentId: agentId ?? null,
          });
        } else {
          rawNotes = await neo4jService.run(FILTER_SEARCH_NOTES_QUERY, {
            projectId: resolvedProjectId,
            limit: Math.floor(limit),
            category: category ?? null,
            severity: severity ?? null,
            sessionId: sessionId ?? null,
            agentId: agentId ?? null,
          });
        }

        const notes = rawNotes.map((row: any) => {
          const createdAt =
            typeof row.createdAt === 'object' && row.createdAt?.toNumber ? row.createdAt.toNumber() : row.createdAt;
          const expiresAt =
            typeof row.expiresAt === 'object' && row.expiresAt?.toNumber ? row.expiresAt.toNumber() : row.expiresAt;
          const aboutNodes = (row.aboutNodes ?? []).filter((n: any) => n?.id != null);

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
            aboutNodes,
          };
        });

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
              bookmark,
              workingSet,
              staleNodeIds,
              notes,
              stats: {
                notesCount: notes.length,
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
