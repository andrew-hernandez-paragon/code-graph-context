/**
 * Session Note Tools
 * Save and recall cross-session observations, decisions, and insights
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService, getEmbeddingDimensions } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

const NOTE_CATEGORIES = ['architectural', 'bug', 'insight', 'decision', 'risk', 'todo'] as const;
const NOTE_SEVERITIES = ['info', 'warning', 'critical'] as const;

/**
 * Cypher to create a SessionNote node, link it to code nodes via [:ABOUT],
 * and link it to the latest SessionBookmark for the session via [:HAS_NOTE]
 */
const CREATE_SESSION_NOTE_QUERY = `
  // Create the SessionNote node
  CREATE (n:SessionNote {
    id: $noteId,
    projectId: $projectId,
    sessionId: $sessionId,
    agentId: $agentId,
    topic: $topic,
    content: $content,
    category: $category,
    severity: $severity,
    createdAt: timestamp(),
    expiresAt: $expiresAt
  })

  // Link to referenced code nodes (filter out internal coordination nodes)
  WITH n
  UNWIND CASE WHEN size($aboutNodeIds) = 0 THEN [null] ELSE $aboutNodeIds END AS aboutNodeId
  OPTIONAL MATCH (target)
  WHERE aboutNodeId IS NOT NULL
    AND target.id = aboutNodeId
    AND target.projectId = $projectId
    AND NOT target:SessionNote
    AND NOT target:SessionBookmark
    AND NOT target:Pheromone
    AND NOT target:SwarmTask
  WITH n, collect(target) AS targets
  FOREACH (t IN [x IN targets WHERE x IS NOT NULL] | MERGE (n)-[:ABOUT]->(t))

  // Link to the latest SessionBookmark for this session (if one exists)
  WITH n
  OPTIONAL MATCH (bm:SessionBookmark {projectId: $projectId, sessionId: $sessionId})
  WITH n, bm ORDER BY bm.createdAt DESC
  LIMIT 1
  FOREACH (_ IN CASE WHEN bm IS NOT NULL THEN [1] ELSE [] END |
    MERGE (bm)-[:HAS_NOTE]->(n)
  )

  RETURN n.id AS noteId
`;

/**
 * Cypher to store the embedding vector on an existing SessionNote node
 */
const SET_NOTE_EMBEDDING_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  SET n.embedding = $embedding
  RETURN n.id AS noteId
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

/**
 * Generate a unique note ID
 */
const generateNoteId = (): string => {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
};

export const createSaveSessionNoteTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.saveSessionNote,
    {
      title: TOOL_METADATA[TOOL_NAMES.saveSessionNote].title,
      description: TOOL_METADATA[TOOL_NAMES.saveSessionNote].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        sessionId: z.string().describe('Session identifier (e.g., conversation ID or session name)'),
        agentId: z.string().describe('Agent identifier that is saving the note'),
        topic: z.string().min(3).max(100).describe('Short topic label for the note'),
        content: z.string().min(10).describe('Full observation text'),
        category: z.enum(NOTE_CATEGORIES).describe('Category: architectural, bug, insight, decision, risk, or todo'),
        severity: z.enum(NOTE_SEVERITIES).optional().default('info').describe('Severity level'),
        aboutNodeIds: z.array(z.string()).optional().default([]).describe('Code node IDs this note is about'),
        expiresInHours: z
          .number()
          .positive()
          .optional()
          .describe('Auto-expire after N hours. Omit for a permanent note.'),
      },
    },
    async ({
      projectId,
      sessionId,
      agentId,
      topic,
      content,
      category,
      severity = 'info',
      aboutNodeIds = [],
      expiresInHours,
    }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        const noteId = generateNoteId();
        const expiresAt = expiresInHours != null ? Date.now() + expiresInHours * 3600 * 1000 : null;

        const createResult = await neo4jService.run(CREATE_SESSION_NOTE_QUERY, {
          noteId,
          projectId: resolvedProjectId,
          sessionId,
          agentId,
          topic,
          content,
          category,
          severity,
          aboutNodeIds,
          expiresAt,
        });

        if (createResult.length === 0) {
          return createErrorResponse('Failed to create session note.');
        }

        // Ensure vector index exists (idempotent — IF NOT EXISTS)
        let hasEmbedding = false;
        try {
          await neo4jService.run(QUERIES.CREATE_SESSION_NOTES_VECTOR_INDEX(getEmbeddingDimensions()));
          const embeddingsService = new EmbeddingsService();
          const embeddingText = `${topic}\n\n${content}`;
          const embedding = await embeddingsService.embedText(embeddingText);
          await neo4jService.run(SET_NOTE_EMBEDDING_QUERY, {
            noteId,
            projectId: resolvedProjectId,
            embedding,
          });
          hasEmbedding = true;
        } catch (embErr) {
          await debugLog('Session note embedding failed (non-fatal)', { error: String(embErr), noteId });
        }

        return createSuccessResponse(
          JSON.stringify(
            {
              success: true,
              noteId,
              topic,
              category,
              severity,
              hasEmbedding,
              expiresAt: expiresAt != null ? new Date(expiresAt).toISOString() : null,
              projectId: resolvedProjectId,
              sessionId,
              agentId,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await debugLog('Save session note error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};

export const createRecallSessionNotesTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.recallSessionNotes,
    {
      title: TOOL_METADATA[TOOL_NAMES.recallSessionNotes].title,
      description: TOOL_METADATA[TOOL_NAMES.recallSessionNotes].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        query: z
          .string()
          .optional()
          .describe('Natural language search query. When provided, triggers semantic vector search.'),
        category: z
          .enum(NOTE_CATEGORIES)
          .optional()
          .describe('Filter by category: architectural, bug, insight, decision, risk, todo'),
        severity: z.enum(NOTE_SEVERITIES).optional().describe('Filter by severity: info, warning, critical'),
        sessionId: z.string().optional().describe('Filter by session ID'),
        agentId: z.string().optional().describe('Filter by agent ID'),
        limit: z.number().int().min(1).max(50).optional().default(10).describe('Maximum number of notes to return'),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.3)
          .describe('Minimum similarity score for vector search'),
      },
    },
    async ({ projectId, query, category, severity, sessionId, agentId, limit = 10, minSimilarity = 0.3 }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        let rawNotes: any[];

        if (query) {
          // Semantic search mode
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
          // Filter-based search mode
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

          // Filter out null entries from optional ABOUT matches
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

        return createSuccessResponse(
          JSON.stringify(
            {
              count: notes.length,
              projectId: resolvedProjectId,
              searchMode: query ? 'semantic' : 'filter',
              filters: {
                query: query ?? null,
                category: category ?? null,
                severity: severity ?? null,
                sessionId: sessionId ?? null,
                agentId: agentId ?? null,
              },
              notes,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await debugLog('Recall session notes error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
