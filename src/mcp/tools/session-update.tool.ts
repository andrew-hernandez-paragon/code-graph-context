/**
 * Session Update Tool (Phase 1.5c)
 *
 * In-place revision of an existing SessionNote. Designed for the small-edit
 * case so the corpus stays clean instead of accumulating a chain of
 * near-identical superseded notes for every typo.
 *
 * Use this for:
 *   - typo / clarity polish
 *   - severity change (info ↔ warning ↔ critical)
 *   - lastValidated bump (re-confirmed against current code)
 *   - minor content correction
 *   - aboutNodeIds resync (file moved / symbol renamed)
 *   - tombstoning (set supersededBy to any non-null value)
 *
 * Use session_save with `supersededBy: <oldId>` for substantive content
 * changes or decision reversals — that preserves history as a new note.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService, getEmbeddingDimensions } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

// ---------------------------------------------------------------------------
// Cypher
// ---------------------------------------------------------------------------

/**
 * Update only the provided fields on a SessionNote and bump `lastValidated`.
 *
 * `supersededByProvided` allows the caller to explicitly clear `supersededBy`
 * by passing `null` — distinguishable from "field not provided."
 */
const UPDATE_NOTE_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  WITH n,
       n.aboutNodeIds AS oldAboutNodeIds,
       coalesce($aboutNodeIds, n.aboutNodeIds) AS newAboutNodeIds
  SET n.content       = coalesce($content,    n.content),
      n.topic         = coalesce($topic,      n.topic),
      n.category      = coalesce($category,   n.category),
      n.severity      = coalesce($severity,   n.severity),
      n.aboutNodeIds  = newAboutNodeIds,
      n.supersededBy  = CASE WHEN $supersededByProvided THEN $supersededBy ELSE n.supersededBy END,
      n.lastValidated = timestamp()
  RETURN n.id AS noteId,
         n.topic AS topic,
         n.content AS content,
         n.category AS category,
         n.severity AS severity,
         n.aboutNodeIds AS aboutNodeIds,
         n.supersededBy AS supersededBy,
         n.lastValidated AS lastValidated,
         oldAboutNodeIds,
         newAboutNodeIds,
         (oldAboutNodeIds <> newAboutNodeIds) AS aboutNodeIdsChanged
`;

/**
 * Drop existing :ABOUT edges from the note before recreating them with the
 * updated aboutNodeIds. Used only when aboutNodeIds changed.
 */
const DROP_ABOUT_EDGES_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})-[r:ABOUT]->()
  DELETE r
  RETURN count(r) AS dropped
`;

/**
 * Recreate :ABOUT edges from the note to its current aboutNodeIds. Same guard
 * pattern as session-save: filter out coordination labels from targets.
 */
const RECREATE_NOTE_ABOUT_EDGES_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  UNWIND $aboutNodeIds AS aboutId
  MATCH (target {id: aboutId, projectId: $projectId})
  WHERE NOT target:SessionNote
    AND NOT target:SessionBookmark
    AND NOT target:Pheromone
    AND NOT target:SwarmTask
  MERGE (n)-[r:ABOUT]->(target)
  RETURN count(r) AS created
`;

const SET_NOTE_EMBEDDING_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  SET n.embedding = $embedding
  RETURN n.id AS noteId
`;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const createSessionUpdateTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.sessionUpdate,
    {
      title: TOOL_METADATA[TOOL_NAMES.sessionUpdate].title,
      description: TOOL_METADATA[TOOL_NAMES.sessionUpdate].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        noteId: z.string().describe('ID of the SessionNote to update'),
        topic: z.string().min(3).max(100).optional().describe('Replace the topic label'),
        content: z.string().min(10).optional().describe('Replace the content. Triggers re-embedding.'),
        category: z
          .enum(['architectural', 'bug', 'insight', 'decision', 'risk', 'todo'])
          .optional()
          .describe('Replace the category'),
        severity: z.enum(['info', 'warning', 'critical']).optional().describe('Replace the severity'),
        aboutNodeIds: z
          .array(z.string())
          .optional()
          .describe('Replace the set of code nodes this note references. Triggers :ABOUT edge resync.'),
        supersededBy: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Set to a noteId (or any non-null value) to mark this note superseded. Pass `null` explicitly to clear. Omit to leave unchanged.',
          ),
      },
    },
    async (args) => {
      const {
        projectId,
        noteId,
        topic,
        content,
        category,
        severity,
        aboutNodeIds,
      } = args;

      // Distinguish "not provided" from "explicitly null" for supersededBy.
      const supersededByProvided = Object.prototype.hasOwnProperty.call(args, 'supersededBy');
      const supersededBy = supersededByProvided ? (args.supersededBy ?? null) : null;

      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Apply the SET. Returns empty rows if the note doesn't exist.
        const updateRows = await neo4jService.run(UPDATE_NOTE_QUERY, {
          projectId: resolvedProjectId,
          noteId,
          topic: topic ?? null,
          content: content ?? null,
          category: category ?? null,
          severity: severity ?? null,
          aboutNodeIds: aboutNodeIds ?? null,
          supersededBy,
          supersededByProvided,
        });

        if (updateRows.length === 0) {
          return createErrorResponse(`SessionNote not found: id=${noteId}, projectId=${resolvedProjectId}`);
        }

        const updated = updateRows[0];
        const aboutNodeIdsChanged = !!updated.aboutNodeIdsChanged;
        const updatedAboutNodeIds: string[] = Array.isArray(updated.aboutNodeIds) ? updated.aboutNodeIds : [];

        // If aboutNodeIds changed, drop existing :ABOUT edges and recreate.
        let aboutEdgesDropped = 0;
        let aboutEdgesCreated = 0;
        if (aboutNodeIdsChanged) {
          const dropResult = await neo4jService.run(DROP_ABOUT_EDGES_QUERY, {
            projectId: resolvedProjectId,
            noteId,
          });
          aboutEdgesDropped = toNumber(dropResult[0]?.dropped);

          if (updatedAboutNodeIds.length > 0) {
            const createResult = await neo4jService.run(RECREATE_NOTE_ABOUT_EDGES_QUERY, {
              projectId: resolvedProjectId,
              noteId,
              aboutNodeIds: updatedAboutNodeIds,
            });
            aboutEdgesCreated = toNumber(createResult[0]?.created);
          }
        }

        // If content or topic changed, re-embed. Best-effort, non-fatal.
        let reEmbedded = false;
        if (content != null || topic != null) {
          try {
            await neo4jService.run(QUERIES.CREATE_SESSION_NOTES_VECTOR_INDEX(getEmbeddingDimensions()));
            const embeddingsService = new EmbeddingsService();
            const embeddingText = `${updated.topic}\n\n${updated.content}`;
            const embedding = await embeddingsService.embedText(embeddingText);
            await neo4jService.run(SET_NOTE_EMBEDDING_QUERY, {
              noteId,
              projectId: resolvedProjectId,
              embedding,
            });
            reEmbedded = true;
          } catch (embErr) {
            await debugLog('session_update: re-embed failed (non-fatal)', { error: String(embErr), noteId });
          }
        }

        return createSuccessResponse(
          JSON.stringify(
            {
              success: true,
              noteId: updated.noteId,
              projectId: resolvedProjectId,
              fieldsUpdated: {
                topic: topic != null,
                content: content != null,
                category: category != null,
                severity: severity != null,
                aboutNodeIds: aboutNodeIdsChanged,
                supersededBy: supersededByProvided,
              },
              aboutEdges: aboutNodeIdsChanged
                ? { dropped: aboutEdgesDropped, created: aboutEdgesCreated }
                : null,
              reEmbedded,
              lastValidated: toNumber(updated.lastValidated),
              note: {
                topic: updated.topic,
                category: updated.category,
                severity: updated.severity,
                supersededBy: updated.supersededBy ?? null,
              },
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await debugLog('session_update error', { error: String(error), noteId });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};

const toNumber = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v && 'toNumber' in (v as object)) {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v) || 0;
};
