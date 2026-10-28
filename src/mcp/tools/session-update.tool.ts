/**
 * Session Update Tool
 * Revises an existing SessionNote in place; session_save with `supersedes` replaces a note and keeps its history.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { InvalidProjectInputError, ProjectService } from '../../core/projects/index.js';
import { NOTE_CATEGORIES, NOTE_SEVERITIES } from '../../core/session/note-vocabulary.js';
import { SessionEmbeddingService } from '../../core/session/session-embedding.service.js';
import { toNumber } from '../../core/utils/shared-utils.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA, PROJECT_ID_DESCRIPTION } from '../constants.js';
import { SessionAnchorService } from '../handlers/session-anchor.service.js';
import { saveSessionNoteChunks } from '../handlers/session-note-chunks.js';
import { createErrorResponse, createSuccessResponse, findProjectOrError, debugLog } from '../utils.js';

const FIND_NOTE_ANCHORS_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  RETURN coalesce(n.aboutNodeIds, []) AS aboutNodeIds, coalesce(n.aboutPaths, []) AS aboutPaths
`;

/**
 * Update only the provided fields on a SessionNote and bump `lastValidated`.
 * The anchors are always written (the stored ones when the caller sent none) so the
 * path hashes are taken again: an update means the note was checked against the current code.
 *
 * `supersededByProvided` allows the caller to explicitly clear `supersededBy`
 * by passing `null`, distinguishable from "field not provided."
 */
export const UPDATE_NOTE_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  SET n.content         = coalesce($content,    n.content),
      n.topic           = coalesce($topic,      n.topic),
      n.category        = coalesce($category,   n.category),
      n.severity        = coalesce($severity,   n.severity),
      n.aboutNodeIds    = $aboutNodeIds,
      n.aboutPaths      = $aboutPaths,
      n.aboutPathHashes = $aboutPathHashes,
      n.supersededBy    = CASE WHEN $supersededByProvided THEN $supersededBy ELSE n.supersededBy END,
      n.lastValidated   = timestamp()
  WITH n
  OPTIONAL MATCH (c:SessionNoteChunk {projectId: $projectId, parentNoteId: $noteId})
  WHERE $content IS NOT NULL
  WITH n, collect(c) AS staleChunks
  FOREACH (c IN staleChunks | DETACH DELETE c)
  RETURN n.id AS noteId,
         n.topic AS topic,
         n.content AS content,
         n.category AS category,
         n.severity AS severity,
         n.supersededBy AS supersededBy,
         n.lastValidated AS lastValidated
`;

/**
 * Drop existing :ABOUT edges from the note before recreating them from its
 * anchors. Used only when the caller sent aboutNodeIds or aboutPaths.
 */
export const DROP_ABOUT_EDGES_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})-[r:ABOUT]->()
  DELETE r
  RETURN count(r) AS dropped
`;

/**
 * Recreate :ABOUT edges from the note to its code nodes (in any codebase) and to the
 * SourceFile of each anchor path inside a codebase. Targets match :GraphNode, which
 * excludes session and coordination nodes.
 */
export const RECREATE_NOTE_ABOUT_EDGES_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  CALL (n) {
    UNWIND $nodeRefs AS ref
    MATCH (target:GraphNode {id: ref.id, projectId: ref.projectId})
    MERGE (n)-[r:ABOUT]->(target)
    RETURN count(r) AS nodeEdges
  }
  CALL (n) {
    UNWIND $sourceFileRefs AS fileRef
    MATCH (file:SourceFile {projectId: fileRef.projectId, filePath: fileRef.filePath})
    MERGE (n)-[r:ABOUT]->(file)
    RETURN count(r) AS fileEdges
  }
  RETURN nodeEdges + fileEdges AS created
`;

/**
 * Moves the note and its chunks to another project. Anchors stay as they are: node ids,
 * :ABOUT edges and aboutPaths do not depend on the project that holds the note.
 */
export const MOVE_NOTE_QUERY = `
  MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
  SET n.projectId = $targetProjectId
  WITH n
  OPTIONAL MATCH (c:SessionNoteChunk {projectId: $projectId, parentNoteId: $noteId})
  SET c.projectId = $targetProjectId
  RETURN n.id AS noteId, count(c) AS chunks
`;

export const createSessionUpdateTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.sessionUpdate,
    {
      title: TOOL_METADATA[TOOL_NAMES.sessionUpdate].title,
      description: TOOL_METADATA[TOOL_NAMES.sessionUpdate].description,
      annotations: TOOL_METADATA[TOOL_NAMES.sessionUpdate].annotations,
      inputSchema: {
        projectId: z.string().describe(PROJECT_ID_DESCRIPTION.any),
        noteId: z.string().describe('ID of the SessionNote to update'),
        topic: z.string().min(3).max(100).optional().describe('Replace the topic label'),
        content: z.string().min(10).optional().describe('Replace the content. Triggers re-embedding.'),
        category: z.enum(NOTE_CATEGORIES).optional().describe('Replace the category'),
        severity: z.enum(NOTE_SEVERITIES).optional().describe('Replace the severity'),
        aboutNodeIds: z
          .array(z.string())
          .optional()
          .describe(
            'Replace the set of code nodes this note references. They may belong to any codebase. Triggers :ABOUT edge resync.',
          ),
        aboutPaths: z
          .array(z.string())
          .optional()
          .describe(
            'Replace the files and folders this note is about. Absolute, ~/ or relative to the project directory. Triggers :ABOUT edge resync.',
          ),
        supersededBy: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Set to a noteId (or any non-null value) to mark this note superseded. Pass `null` explicitly to clear. Omit to leave unchanged.',
          ),
        moveToProjectId: z
          .string()
          .optional()
          .describe(
            "Move the note and its chunks to this project or collection (id, name or path). Its anchors stay as they are. Moving to the note's current project does nothing.",
          ),
      },
    },
    async (args) => {
      const { projectId, noteId, topic, content, category, severity, aboutNodeIds, aboutPaths, moveToProjectId } = args;

      // Distinguish "not provided" from "explicitly null" for supersededBy.
      const supersededByProvided = Object.prototype.hasOwnProperty.call(args, 'supersededBy');
      const supersededBy = supersededByProvided ? (args.supersededBy ?? null) : null;

      const neo4jService = new Neo4jService();

      try {
        const projectResult = await findProjectOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const project = projectResult.project;
        const resolvedProjectId = project.projectId;

        const targetResult = moveToProjectId ? await findProjectOrError(moveToProjectId, neo4jService) : null;
        if (targetResult && !targetResult.success) return targetResult.error;
        const moveTarget = targetResult?.project.projectId !== resolvedProjectId ? targetResult?.project : undefined;

        const storedRows = await neo4jService.run(FIND_NOTE_ANCHORS_QUERY, { projectId: resolvedProjectId, noteId });
        if (storedRows.length === 0) {
          return createErrorResponse(`SessionNote not found: id=${noteId}, projectId=${resolvedProjectId}`);
        }
        const anchorsProvided = aboutNodeIds != null || aboutPaths != null;
        const anchors = await new SessionAnchorService(new ProjectService(neo4jService), neo4jService).resolveAnchors(
          project,
          {
            nodeIds: aboutNodeIds ?? storedRows[0].aboutNodeIds,
            paths: aboutPaths ?? storedRows[0].aboutPaths,
          },
        );

        const updateRows = await neo4jService.run(UPDATE_NOTE_QUERY, {
          projectId: resolvedProjectId,
          noteId,
          topic: topic ?? null,
          content: content ?? null,
          category: category ?? null,
          severity: severity ?? null,
          aboutNodeIds: anchors.nodeIds,
          aboutPaths: anchors.paths,
          aboutPathHashes: anchors.pathHashes,
          supersededBy,
          supersededByProvided,
        });
        const updated = updateRows[0];

        let aboutEdgesDropped = 0;
        let aboutEdgesCreated = 0;
        if (anchorsProvided) {
          const dropResult = await neo4jService.run(DROP_ABOUT_EDGES_QUERY, {
            projectId: resolvedProjectId,
            noteId,
          });
          aboutEdgesDropped = toNumber(dropResult[0]?.dropped);

          const createResult = await neo4jService.run(RECREATE_NOTE_ABOUT_EDGES_QUERY, {
            projectId: resolvedProjectId,
            noteId,
            nodeRefs: anchors.nodeRefs,
            sourceFileRefs: anchors.sourceFileRefs,
          });
          aboutEdgesCreated = toNumber(createResult[0]?.created);
        }

        const reEmbedded =
          content != null || topic != null
            ? await new SessionEmbeddingService(neo4jService, new EmbeddingsService()).reembedNote({
                noteId,
                projectId: resolvedProjectId,
                topic: updated.topic,
                content: updated.content,
              })
            : false;

        if (content != null) {
          try {
            await saveSessionNoteChunks(neo4jService, resolvedProjectId, noteId, updated.content);
          } catch (chunkErr) {
            await debugLog('session_update: note chunk embedding failed', { error: String(chunkErr), noteId });
          }
        }

        const moveRows = moveTarget
          ? await neo4jService.run(MOVE_NOTE_QUERY, {
              projectId: resolvedProjectId,
              noteId,
              targetProjectId: moveTarget.projectId,
            })
          : [];

        return createSuccessResponse(
          JSON.stringify(
            {
              success: true,
              noteId: updated.noteId,
              projectId: moveTarget?.projectId ?? resolvedProjectId,
              moved: moveTarget
                ? {
                    from: resolvedProjectId,
                    to: moveTarget.projectId,
                    toName: moveTarget.name,
                    chunks: toNumber(moveRows[0]?.chunks ?? 0),
                  }
                : null,
              fieldsUpdated: {
                topic: topic != null,
                content: content != null,
                category: category != null,
                severity: severity != null,
                aboutNodeIds: aboutNodeIds != null,
                aboutPaths: aboutPaths != null,
                supersededBy: supersededByProvided,
              },
              aboutEdges: anchorsProvided ? { dropped: aboutEdgesDropped, created: aboutEdgesCreated } : null,
              unresolvedAboutNodeIds: anchors.unresolvedNodeIds,
              missingAboutPaths: anchors.missingPaths,
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
        if (error instanceof InvalidProjectInputError) return createErrorResponse(error);
        await debugLog('session_update error', { error: String(error), noteId });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
