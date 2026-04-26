/**
 * Session Save Tool
 * Unified tool that merges save_session_bookmark and save_session_note into one call.
 * Auto-detects bookmark vs note based on input fields provided.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService, getEmbeddingDimensions } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

// ---------------------------------------------------------------------------
// Cypher queries (copied from their respective source tools)
// ---------------------------------------------------------------------------

const CREATE_BOOKMARK_QUERY = `
  CREATE (b:SessionBookmark {
    id: $bookmarkId,
    projectId: $projectId,
    sessionId: $sessionId,
    agentId: $agentId,
    summary: $summary,
    workingSetNodeIds: $workingSetNodeIds,
    taskContext: $taskContext,
    findings: $findings,
    nextSteps: $nextSteps,
    metadata: $metadata,
    createdAt: timestamp(),
    updatedAt: timestamp()
  })

  // Link to referenced code nodes (exclude coordination nodes)
  WITH b
  OPTIONAL MATCH (target)
  WHERE target.id IN $workingSetNodeIds
    AND target.projectId = $projectId
    AND NOT target:Pheromone
    AND NOT target:SwarmTask
    AND NOT target:SessionBookmark
    AND NOT target:SessionNote
  WITH b, collect(DISTINCT target) AS targets
  FOREACH (t IN targets | MERGE (b)-[:REFERENCES]->(t))

  RETURN b.id AS id,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.taskContext AS taskContext,
         b.createdAt AS createdAt,
         size(targets) AS linkedNodes
`;

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
    aboutNodeIds: $aboutNodeIds,
    lastValidated: timestamp(),
    supersededBy: $supersededBy,
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

const SET_NOTE_EMBEDDING_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  SET n.embedding = $embedding
  RETURN n.id AS noteId
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generateBookmarkId = (): string =>
  `bookmark_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

const generateNoteId = (): string => `note_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const createSessionSaveTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.sessionSave,
    {
      title: TOOL_METADATA[TOOL_NAMES.sessionSave].title,
      description: TOOL_METADATA[TOOL_NAMES.sessionSave].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        sessionId: z.string().describe('Session/conversation identifier'),
        agentId: z.string().describe('Your agent identifier'),
        type: z
          .enum(['bookmark', 'note', 'auto'])
          .optional()
          .default('auto')
          .describe('Force bookmark or note, or auto-detect from input'),
        // Bookmark fields
        summary: z.string().min(10).optional().describe('Current work state summary'),
        workingSetNodeIds: z.array(z.string()).optional().describe('Code node IDs you are focused on'),
        taskContext: z.string().optional().describe('High-level task being worked on'),
        findings: z.string().optional().describe('Key discoveries or decisions'),
        nextSteps: z.string().optional().describe('What to do next when resuming'),
        // Note fields
        topic: z.string().min(3).max(100).optional().describe('Short topic label'),
        content: z.string().min(10).optional().describe('Full observation text'),
        category: z
          .enum(['architectural', 'bug', 'insight', 'decision', 'risk', 'todo'])
          .optional()
          .describe('Note category'),
        severity: z.enum(['info', 'warning', 'critical']).optional().default('info').describe('Note severity'),
        aboutNodeIds: z.array(z.string()).optional().describe('Code node IDs this note is about'),
        supersededBy: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Note ID that obsoletes this one. Recall filters out notes with non-null supersededBy by default. Use to tombstone a note that has a replacement, or to mark a note as outdated without a replacement (set to any non-null value).',
          ),
        expiresInHours: z.number().optional().describe('Auto-expire note after N hours'),
        metadata: z.string().optional().describe('Additional structured data as JSON string (bookmark only — silently ignored on note saves)'),
      },
    },
    async ({
      projectId,
      sessionId,
      agentId,
      type = 'auto',
      summary,
      workingSetNodeIds,
      taskContext,
      findings = '',
      nextSteps = '',
      topic,
      content,
      category,
      severity = 'info',
      aboutNodeIds = [],
      supersededBy = null,
      expiresInHours,
      metadata,
    }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      // Determine effective operation mode
      const hasBookmarkFields = workingSetNodeIds != null && workingSetNodeIds.length > 0;
      const hasNoteFields = topic != null && content != null;

      let effectiveType: 'bookmark' | 'note' | 'both';
      if (type === 'bookmark') {
        effectiveType = 'bookmark';
      } else if (type === 'note') {
        effectiveType = 'note';
      } else {
        // auto-detect
        if (hasBookmarkFields && hasNoteFields) {
          effectiveType = 'both';
        } else if (hasBookmarkFields) {
          effectiveType = 'bookmark';
        } else if (hasNoteFields) {
          effectiveType = 'note';
        } else {
          await neo4jService.close();
          return createErrorResponse(
            'Cannot auto-detect type: provide workingSetNodeIds for a bookmark, topic+content for a note, or both.',
          );
        }
      }

      try {
        // Validate required fields per operation
        if ((effectiveType === 'bookmark' || effectiveType === 'both') && !summary) {
          return createErrorResponse('summary is required when saving a bookmark.');
        }
        if ((effectiveType === 'bookmark' || effectiveType === 'both') && !taskContext) {
          return createErrorResponse('taskContext is required when saving a bookmark.');
        }
        if (
          (effectiveType === 'bookmark' || effectiveType === 'both') &&
          (!workingSetNodeIds || workingSetNodeIds.length === 0)
        ) {
          return createErrorResponse('workingSetNodeIds is required when saving a bookmark.');
        }
        if ((effectiveType === 'note' || effectiveType === 'both') && !topic) {
          return createErrorResponse('topic is required when saving a note.');
        }
        if ((effectiveType === 'note' || effectiveType === 'both') && !content) {
          return createErrorResponse('content is required when saving a note.');
        }
        if ((effectiveType === 'note' || effectiveType === 'both') && !category) {
          return createErrorResponse('category is required when saving a note.');
        }

        const result: Record<string, unknown> = { success: true, projectId: resolvedProjectId, sessionId, agentId };

        // ── Create bookmark ──────────────────────────────────────────────────
        if (effectiveType === 'bookmark' || effectiveType === 'both') {
          const bookmarkId = generateBookmarkId();
          const metadataJson = metadata ?? null;

          const bookmarkRows = await neo4jService.run(CREATE_BOOKMARK_QUERY, {
            bookmarkId,
            projectId: resolvedProjectId,
            sessionId,
            agentId,
            summary: summary!,
            workingSetNodeIds: workingSetNodeIds!,
            taskContext: taskContext!,
            findings,
            nextSteps,
            metadata: metadataJson,
          });

          if (bookmarkRows.length === 0) {
            return createErrorResponse(
              effectiveType === 'both'
                ? 'Failed to create session bookmark; note was not saved.'
                : 'Failed to create session bookmark.',
            );
          }

          const bm = bookmarkRows[0];
          const linkedNodes =
            typeof bm.linkedNodes === 'object' && bm.linkedNodes?.toNumber
              ? bm.linkedNodes.toNumber()
              : (bm.linkedNodes ?? 0);

          // Embed the bookmark for semantic recall (Phase 1.5b).
          // Mirror of the note-embedding pattern below: best-effort, non-fatal.
          let bookmarkHasEmbedding = false;
          try {
            await neo4jService.run(QUERIES.CREATE_SESSION_BOOKMARKS_VECTOR_INDEX(getEmbeddingDimensions()));
            const embeddingsService = new EmbeddingsService();
            const embeddingText = [taskContext!, summary!, findings, nextSteps]
              .filter((s) => s && s.length > 0)
              .join('\n\n');
            const embedding = await embeddingsService.embedText(embeddingText);
            await neo4jService.run(QUERIES.SET_BOOKMARK_EMBEDDING_QUERY, {
              bookmarkId,
              projectId: resolvedProjectId,
              embedding,
            });
            bookmarkHasEmbedding = true;
          } catch (embErr) {
            await debugLog('Session save bookmark embedding failed (non-fatal)', {
              error: String(embErr),
              bookmarkId,
            });
          }

          result.bookmark = {
            bookmarkId: bm.id,
            summary: bm.summary,
            taskContext: bm.taskContext,
            workingSetSize: workingSetNodeIds!.length,
            linkedNodes,
            hasEmbedding: bookmarkHasEmbedding,
            createdAt:
              typeof bm.createdAt === 'object' && bm.createdAt?.toNumber ? bm.createdAt.toNumber() : bm.createdAt,
            message: `Session bookmark saved. ${linkedNodes} of ${workingSetNodeIds!.length} working set nodes linked in graph.`,
          };
        }

        // ── Create note ──────────────────────────────────────────────────────
        if (effectiveType === 'note' || effectiveType === 'both') {
          const noteId = generateNoteId();
          const expiresAt = expiresInHours != null ? Date.now() + expiresInHours * 3600 * 1000 : null;

          const noteRows = await neo4jService.run(CREATE_SESSION_NOTE_QUERY, {
            noteId,
            projectId: resolvedProjectId,
            sessionId,
            agentId,
            topic: topic!,
            content: content!,
            category: category!,
            severity,
            aboutNodeIds,
            supersededBy,
            expiresAt,
          });

          if (noteRows.length === 0) {
            return createErrorResponse('Failed to create session note.');
          }

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
            await debugLog('Session save note embedding failed (non-fatal)', { error: String(embErr), noteId });
          }

          result.note = {
            noteId,
            topic: topic!,
            category: category!,
            severity,
            hasEmbedding,
            expiresAt: expiresAt != null ? new Date(expiresAt).toISOString() : null,
          };
        }

        result.type = effectiveType;

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        await debugLog('Session save error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
