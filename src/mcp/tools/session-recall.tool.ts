/**
 * Session Recall Tool
 * Recalls the bookmark to resume from and the notes that match a query, across one or more projects.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getNoteRecallFloor, UNCALIBRATED_RECALL_FLOOR } from '../../core/embeddings/embedding-config.js';
import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import {
  changedPathsOf,
  findMissingAnchorPaths,
  fingerprintAnchorPaths,
  missingPathsOf,
} from '../../core/session/anchor-paths.js';
import { NOTE_CATEGORIES, NOTE_SEVERITIES } from '../../core/session/note-vocabulary.js';
import { toNumberOrNull } from '../../core/utils/shared-utils.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import {
  NOTE_CANDIDATES_PER_PROJECT,
  nearestNeighborsInProjects,
  nearestNeighborsPerRow,
  runProjectFilteredSearch,
} from '../../storage/neo4j/project-vector-search.js';
import { VECTOR_INDEXES } from '../../storage/neo4j/vector-indexes.js';
import { TOOL_NAMES, TOOL_METADATA, PROJECT_ID_DESCRIPTION } from '../constants.js';
import {
  NOTE_ABOUT_NODES_CLAUSE,
  NOTE_NOT_EXPIRED_CLAUSE,
  NOTE_NOT_SUPERSEDED_CLAUSE,
} from '../handlers/session-note-query-clauses.js';
import {
  createEmptyResponse,
  createErrorResponse,
  createSuccessResponse,
  findProjectsOrError,
  debugLog,
} from '../utils.js';

const MAX_RECALL_PROJECTS = 10;

const BOOKMARK_CANDIDATES_PER_PROJECT = 100;

const BOOKMARK_COLUMNS = `
         b.id AS id,
         b.projectId AS projectId,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.workingSetNodeIds AS workingSetNodeIds,
         coalesce(b.workingSetPaths, []) AS workingSetPaths,
         b.taskContext AS taskContext,
         b.findings AS findings,
         b.nextSteps AS nextSteps,
         b.metadata AS metadata,
         b.createdAt AS createdAt,
         b.updatedAt AS updatedAt`;

const NOTE_COLUMNS = `
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

/**
 * Neo4j query to find the most recent SessionBookmark matching filters
 */
export const FIND_BOOKMARK_QUERY = `
  MATCH (b:SessionBookmark)
  WHERE b.projectId IN $projectIds
    AND ($sessionId IS NULL OR b.sessionId = $sessionId)
    AND ($agentId IS NULL OR b.agentId = $agentId)
  RETURN ${BOOKMARK_COLUMNS}
  ORDER BY b.createdAt DESC
  LIMIT 1
`;

/**
 * Semantic (vector) search for SessionBookmarks.
 *
 * Used when `query` is provided AND `sessionId` is not, i.e. "find me the
 * bookmark from when I was working on X" without knowing which conversation.
 * Depends on the session_bookmarks_idx vector index.
 */
export const VECTOR_SEARCH_BOOKMARKS_QUERY = `${nearestNeighborsInProjects({
  index: VECTOR_INDEXES.sessionBookmarks,
  node: 'b',
  score: 'relevance',
  queryVector: '$queryEmbedding',
  neighbors: String(BOOKMARK_CANDIDATES_PER_PROJECT),
})}
  WITH b, relevance
  WHERE ($agentId IS NULL OR b.agentId = $agentId)
    AND relevance >= $minSimilarity
  RETURN ${BOOKMARK_COLUMNS},
         relevance
  ORDER BY relevance DESC, b.createdAt DESC
  LIMIT 1
`;

/**
 * Neo4j query to get code nodes referenced by a bookmark
 */
export const GET_BOOKMARK_WORKING_SET_QUERY = `
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

const NOTE_FILTERS = `
    ${NOTE_NOT_EXPIRED_CLAUSE}
    AND ($category IS NULL OR n.category = $category)
    AND ($severity IS NULL OR n.severity = $severity)
    AND ($sessionId IS NULL OR n.sessionId = $sessionId)
    AND ($agentId IS NULL OR n.agentId = $agentId)
    AND ($includeSuperseded OR ${NOTE_NOT_SUPERSEDED_CLAUSE})`;

const ABOUT_NODES_COLUMN = `collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath, projectId: codeNode.projectId}) AS aboutNodes`;

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
const buildNoteSearchQuery = (): string => `CYPHER 25
  CALL () {
    ${notePool(VECTOR_INDEXES.sessionNotes, 'note')}
    RETURN note AS n, score
    UNION ALL
    ${notePool(VECTOR_INDEXES.sessionNoteChunks, 'chunk')}
    MATCH (chunk)-[:PART_OF]->(parent:SessionNote)
    RETURN parent AS n, score
  }

  WITH n, max(score) AS score
  WHERE score >= $minSimilarity
    AND ${NOTE_FILTERS}
  WITH n, score
  ORDER BY score DESC,
           n.lastValidated DESC,
           CASE n.severity
             WHEN 'critical' THEN 0
             WHEN 'warning'  THEN 1
             ELSE 2
           END
  LIMIT toInteger($limit)
  ${NOTE_ABOUT_NODES_CLAUSE}

  RETURN ${NOTE_COLUMNS},
    score AS relevance,
    ${ABOUT_NODES_COLUMN}
  ORDER BY score DESC,
           n.lastValidated DESC,
           CASE n.severity
             WHEN 'critical' THEN 0
             WHEN 'warning'  THEN 1
             ELSE 2
           END
`;

export const searchSessionNotes = (
  neo4jService: Pick<Neo4jService, 'run'>,
  params: Record<string, unknown>,
): Promise<any[]> =>
  runProjectFilteredSearch(neo4jService, VECTOR_INDEXES.sessionNotes, buildNoteSearchQuery(), params);

/**
 * Filter-based (non-semantic) search for session notes.
 *
 * Used when no `query` is provided. Orders by lastValidated DESC then
 * createdAt DESC so freshly-revalidated old notes don't sink below
 * shallow new ones. Same supersededBy filter as the vector path.
 */
export const FILTER_SEARCH_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId IN $projectIds
    AND ${NOTE_FILTERS}
  WITH n
  ORDER BY coalesce(n.lastValidated, n.createdAt) DESC,
           n.createdAt DESC
  LIMIT toInteger($limit)
  ${NOTE_ABOUT_NODES_CLAUSE}

  RETURN ${NOTE_COLUMNS},
    null AS relevance,
    ${ABOUT_NODES_COLUMN}
  ORDER BY coalesce(n.lastValidated, n.createdAt) DESC,
           n.createdAt DESC
`;

export const createSessionRecallTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.sessionRecall,
    {
      title: TOOL_METADATA[TOOL_NAMES.sessionRecall].title,
      description: TOOL_METADATA[TOOL_NAMES.sessionRecall].description,
      annotations: TOOL_METADATA[TOOL_NAMES.sessionRecall].annotations,
      inputSchema: {
        projectId: z.string().optional().describe(`${PROJECT_ID_DESCRIPTION.any} Combine with projectIds for several.`),
        projectIds: z
          .array(z.string())
          .min(1)
          .max(MAX_RECALL_PROJECTS)
          .optional()
          .describe(
            'Up to 10 project ids, names, or paths to recall across, such as a repository and a collection. Give projectId, projectIds, or both (their union). list_projects shows every project.',
          ),
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
          .describe(
            'Maximum notes to return. Default 5 keeps recall context tight; pass 10+ when broader retrieval is needed.',
          ),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Minimum similarity for semantic search, on the (1 + cosine) / 2 scale. Default is calibrated per embedding model: 0.80 for BAAI/bge-base-en-v1.5 (cosine 0.60), 0.30 for other models. Lower it to see weaker matches.',
          ),
        includeSuperseded: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When false (default), notes with non-null supersededBy are filtered out, recall returns only current notes. Set true to surface superseded history (e.g. for archaeology).',
          ),
      },
    },
    async ({
      projectId,
      projectIds,
      sessionId,
      agentId,
      query,
      category,
      severity,
      includeCode,
      snippetLength,
      limit,
      minSimilarity: requestedMinSimilarity,
      includeSuperseded,
    }) => {
      const neo4jService = new Neo4jService();
      const minSimilarity = requestedMinSimilarity ?? getNoteRecallFloor();
      // Bookmark matching was not calibrated, so it keeps the long-standing floor.
      const bookmarkMinSimilarity = requestedMinSimilarity ?? UNCALIBRATED_RECALL_FLOOR;

      try {
        const projectInputs = [...new Set([...(projectId ? [projectId] : []), ...(projectIds ?? [])])];
        if (projectInputs.length === 0) {
          return createErrorResponse(
            'Pass projectId or projectIds. Call list_projects to see the registered projects, or pass a directory path.',
          );
        }
        const projectsResult = await findProjectsOrError(projectInputs, neo4jService);
        if (!projectsResult.success) return projectsResult.error;
        const resolvedProjectIds = projectsResult.projects.map((project) => project.projectId);

        let bookmark: Record<string, unknown> | null = null;
        let workingSet: Record<string, unknown>[] = [];
        let staleNodeIds: string[] = [];

        // Embed the query once, reused for both bookmark and notes semantic search.
        let queryEmbedding: number[] | null = null;
        if (query) {
          const embeddingsService = new EmbeddingsService();
          queryEmbedding = await embeddingsService.embedText(query);
        }

        // Choose how to find the bookmark:
        //   sessionId provided    → latest bookmark for that session (resume / continue)
        //   else, queryEmbedding  → top semantic match across all bookmarks
        //   else                  → no bookmark
        let bookmarkRows: any[] = [];
        if (sessionId) {
          bookmarkRows = await neo4jService.run(FIND_BOOKMARK_QUERY, {
            projectIds: resolvedProjectIds,
            sessionId,
            agentId: agentId ?? null,
          });
        } else if (queryEmbedding) {
          bookmarkRows = await runProjectFilteredSearch(
            neo4jService,
            VECTOR_INDEXES.sessionBookmarks,
            VECTOR_SEARCH_BOOKMARKS_QUERY,
            {
              projectIds: resolvedProjectIds,
              queryEmbedding,
              minSimilarity: bookmarkMinSimilarity,
              agentId: agentId ?? null,
            },
          );
        }

        if (bookmarkRows.length > 0) {
          const bm = bookmarkRows[0];

          const workingSetRows = await neo4jService.run(GET_BOOKMARK_WORKING_SET_QUERY, {
            bookmarkId: bm.id,
            projectId: bm.projectId,
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
              startLine: toNumberOrNull(row.startLine),
              endLine: toNumberOrNull(row.endLine),
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

          const workingSetPaths: string[] = bm.workingSetPaths;
          const foundIds = new Set(workingSetRows.map((r: any) => r.id));
          const storedIds: string[] = Array.isArray(bm.workingSetNodeIds) ? bm.workingSetNodeIds : [];
          staleNodeIds = storedIds.filter((id) => !foundIds.has(id));

          bookmark = {
            id: bm.id,
            projectId: bm.projectId,
            sessionId: bm.sessionId,
            agentId: bm.agentId,
            summary: bm.summary,
            taskContext: bm.taskContext,
            findings: bm.findings,
            nextSteps: bm.nextSteps,
            workingSetPaths,
            missingWorkingSetPaths: await findMissingAnchorPaths(workingSetPaths),
            metadata: bm.metadata ? JSON.parse(bm.metadata) : null,
            // matchSource: how the bookmark was selected, useful for the agent to
            // distinguish "this is the bookmark from the current conversation" vs
            // "this is a historical bookmark surfaced via semantic search."
            matchSource: sessionId ? 'sessionId' : 'semantic',
            relevance: bm.relevance != null ? Math.round(bm.relevance * 1000) / 1000 : null,
            createdAt: toNumberOrNull(bm.createdAt),
            updatedAt: toNumberOrNull(bm.updatedAt),
          };
        }

        // Fetch notes, semantic if query provided, filter-based otherwise
        let rawNotes: any[];

        if (queryEmbedding) {
          rawNotes = await searchSessionNotes(neo4jService, {
            projectIds: resolvedProjectIds,
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
            projectIds: resolvedProjectIds,
            limit: Math.floor(limit),
            category: category ?? null,
            severity: severity ?? null,
            sessionId: sessionId ?? null,
            agentId: agentId ?? null,
            includeSuperseded,
          });
        }

        const notes = await Promise.all(
          rawNotes.map(async (row: any) => {
            const aboutNodes = (row.aboutNodes ?? []).filter((n: any) => n?.id != null);

            // IDs persisted on the note that no longer resolve to a current code node.
            const aboutNodeIds: string[] = Array.isArray(row.aboutNodeIds) ? row.aboutNodeIds : [];
            const foundIds = new Set<string>(aboutNodes.map((n: any) => n.id));
            const staleAboutNodeIds = aboutNodeIds.filter((id) => !foundIds.has(id));

            // Only the notes being returned are read from disk.
            const aboutPaths: string[] = row.aboutPaths;
            const fingerprints = await fingerprintAnchorPaths(aboutPaths);

            return {
              id: row.id,
              projectId: row.projectId,
              topic: row.topic,
              content: row.content,
              category: row.category,
              severity: row.severity,
              relevance: row.relevance != null ? Math.round(row.relevance * 1000) / 1000 : null,
              agentId: row.agentId,
              sessionId: row.sessionId,
              createdAt: toNumberOrNull(row.createdAt),
              expiresAt: toNumberOrNull(row.expiresAt),
              lastValidated: toNumberOrNull(row.lastValidated),
              supersededBy: row.supersededBy ?? null,
              aboutNodes,
              staleAboutNodeIds,
              aboutPaths,
              missingAboutPaths: missingPathsOf(fingerprints),
              changedAboutPaths: changedPathsOf(fingerprints, row.aboutPathHashes),
            };
          }),
        );

        const notesWithStaleRefs = notes.filter(
          (n) => n.staleAboutNodeIds.length > 0 || n.missingAboutPaths.length > 0 || n.changedAboutPaths.length > 0,
        ).length;

        const projectLabel = projectsResult.projects
          .map((project) => `${project.name} (${project.projectId})`)
          .join(', ');

        if (!bookmark && notes.length === 0) {
          return createEmptyResponse(
            sessionId
              ? `No bookmark or notes found for session "${sessionId}" in ${projectLabel}`
              : query
                ? `No note was close enough to the query in ${projectLabel}`
                : `No notes found in ${projectLabel}`,
            query
              ? 'Try a different query, or lower minSimilarity to show weaker matches.'
              : 'Save notes or bookmarks with session_save.',
          );
        }

        return createSuccessResponse(
          JSON.stringify(
            {
              success: true,
              projects: projectsResult.projects.map(({ projectId: id, name, kind }) => ({ projectId: id, name, kind })),
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
