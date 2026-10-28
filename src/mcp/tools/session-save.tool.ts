/**
 * Session Save Tool
 * Saves a bookmark or a note in one call; the input fields decide which.
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
import { parseSaveRequest } from '../handlers/session-save-request.js';
import { createErrorResponse, createSuccessResponse, findOrRegisterProjectOrError, debugLog } from '../utils.js';

export const CREATE_BOOKMARK_QUERY = `
  CREATE (b:SessionBookmark {
    id: $bookmarkId,
    projectId: $projectId,
    sessionId: $sessionId,
    agentId: $agentId,
    summary: $summary,
    workingSetNodeIds: $workingSetNodeIds,
    workingSetPaths: $workingSetPaths,
    taskContext: $taskContext,
    findings: $findings,
    nextSteps: $nextSteps,
    metadata: $metadata,
    createdAt: timestamp(),
    updatedAt: timestamp()
  })

  // Link to referenced code nodes in any codebase (:GraphNode excludes coordination nodes)
  WITH b
  UNWIND CASE WHEN size($nodeRefs) = 0 THEN [null] ELSE $nodeRefs END AS ref
  OPTIONAL MATCH (target:GraphNode {id: ref.id, projectId: ref.projectId})
  WITH b, collect(target) AS nodeTargets

  // Link to the SourceFile of each working set path inside a codebase
  UNWIND CASE WHEN size($sourceFileRefs) = 0 THEN [null] ELSE $sourceFileRefs END AS fileRef
  OPTIONAL MATCH (file:SourceFile {projectId: fileRef.projectId, filePath: fileRef.filePath})
  WITH b, nodeTargets, collect(file) AS fileTargets
  FOREACH (t IN [x IN nodeTargets + fileTargets WHERE x IS NOT NULL] | MERGE (b)-[:REFERENCES]->(t))

  RETURN b.id AS id,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.taskContext AS taskContext,
         b.createdAt AS createdAt
`;

export const CREATE_SESSION_NOTE_QUERY = `
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
    aboutPaths: $aboutPaths,
    aboutPathHashes: $aboutPathHashes,
    lastValidated: timestamp(),
    supersededBy: $supersededBy,
    createdAt: timestamp(),
    expiresAt: $expiresAt
  })

  // Link to referenced code nodes in any codebase (:GraphNode excludes coordination nodes)
  WITH n
  UNWIND CASE WHEN size($nodeRefs) = 0 THEN [null] ELSE $nodeRefs END AS ref
  OPTIONAL MATCH (target:GraphNode {id: ref.id, projectId: ref.projectId})
  WITH n, collect(target) AS nodeTargets

  // Link to the SourceFile of each anchor path inside a codebase
  UNWIND CASE WHEN size($sourceFileRefs) = 0 THEN [null] ELSE $sourceFileRefs END AS fileRef
  OPTIONAL MATCH (file:SourceFile {projectId: fileRef.projectId, filePath: fileRef.filePath})
  WITH n, nodeTargets, collect(file) AS fileTargets
  FOREACH (t IN [x IN nodeTargets + fileTargets WHERE x IS NOT NULL] | MERGE (n)-[:ABOUT]->(t))

  // Link to the latest SessionBookmark for this session (if one exists)
  WITH n
  OPTIONAL MATCH (bm:SessionBookmark {projectId: $projectId, sessionId: $sessionId})
  WITH n, bm ORDER BY bm.createdAt DESC
  LIMIT 1
  FOREACH (_ IN CASE WHEN bm IS NOT NULL THEN [1] ELSE [] END |
    MERGE (bm)-[:HAS_NOTE]->(n)
  )

  // Mark the notes this one replaces, in the same transaction as the create
  WITH n
  UNWIND CASE WHEN size($supersedes) = 0 THEN [null] ELSE $supersedes END AS supersededId
  OPTIONAL MATCH (old:SessionNote {id: supersededId, projectId: $projectId})
  FOREACH (o IN CASE WHEN old IS NULL THEN [] ELSE [old] END | SET o.supersededBy = n.id)
  WITH n,
       collect(CASE WHEN old IS NOT NULL THEN supersededId END) AS markedIds,
       collect(CASE WHEN old IS NULL THEN supersededId END) AS notFoundIds

  RETURN n.id AS noteId, markedIds, notFoundIds
`;

const generateBookmarkId = (): string =>
  `bookmark_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

const generateNoteId = (): string => `note_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

export const createSessionSaveTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.sessionSave,
    {
      title: TOOL_METADATA[TOOL_NAMES.sessionSave].title,
      description: TOOL_METADATA[TOOL_NAMES.sessionSave].description,
      annotations: TOOL_METADATA[TOOL_NAMES.sessionSave].annotations,
      inputSchema: {
        projectId: z.string().describe(PROJECT_ID_DESCRIPTION.any),
        sessionId: z
          .string()
          .describe('Your session or conversation id. session_recall with it restores your latest bookmark and notes.'),
        agentId: z.string().describe('Your agent id, stored on the note or bookmark'),
        type: z
          .enum(['bookmark', 'note', 'auto'])
          .optional()
          .default('auto')
          .describe('Force bookmark or note, or auto-detect from input'),
        // Bookmark fields
        summary: z.string().min(10).optional().describe('Current work state summary'),
        workingSetNodeIds: z
          .array(z.string())
          .optional()
          .describe('Code node ids you are focused on, from search_codebase results. They may belong to any codebase.'),
        workingSetPaths: z
          .array(z.string())
          .optional()
          .describe(
            'Files or folders you are focused on. Absolute, ~/ or relative to the project directory (relative paths need a codebase or directory project). A bookmark needs workingSetNodeIds or workingSetPaths.',
          ),
        taskContext: z.string().optional().describe('High-level task being worked on'),
        findings: z.string().optional().describe('Key discoveries or decisions'),
        nextSteps: z.string().optional().describe('What to do next when resuming'),
        // Note fields
        topic: z.string().min(3).max(100).optional().describe('Short topic label'),
        content: z.string().min(10).optional().describe('Full observation text'),
        category: z.enum(NOTE_CATEGORIES).optional().describe('Note category'),
        severity: z.enum(NOTE_SEVERITIES).optional().default('info').describe('Note severity'),
        aboutNodeIds: z
          .array(z.string())
          .optional()
          .describe('Code node ids this note is about, from search_codebase results. They may belong to any codebase.'),
        aboutPaths: z
          .array(z.string())
          .optional()
          .describe(
            'Files or folders this note is about. Absolute, ~/ or relative to the project directory. Recall reports a path that is gone or whose file changed since the save.',
          ),
        supersededBy: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Marks this new note as already superseded, so recall hides it by default. Set it to the id of the note that replaces it, or any non-null value. To replace older notes with this one, use supersedes instead.',
          ),
        supersedes: z
          .array(z.string())
          .optional()
          .describe(
            'IDs of older notes this new note replaces. Each one found in the same project is marked supersededBy the new note, so recall hides it and returns the new note. The result lists which ids were marked and which were not found.',
          ),
        expiresInHours: z.number().optional().describe('Auto-expire note after N hours'),
        metadata: z
          .string()
          .optional()
          .describe('Additional structured data as JSON string (bookmark only, silently ignored on note saves)'),
      },
    },
    async ({ projectId, sessionId, agentId, ...args }) => {
      const neo4jService = new Neo4jService();
      try {
        const projectResult = await findOrRegisterProjectOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const project = projectResult.project;

        const parsed = parseSaveRequest(args);
        if (!parsed.success) return createErrorResponse(parsed.error);
        const { request } = parsed;
        const bookmarkInput = request.kind === 'note' ? null : request.bookmark;
        const noteInput = request.kind === 'bookmark' ? null : request.note;

        // Resolve both anchor sets before the first write, so an invalid path leaves nothing half saved.
        const anchorService = new SessionAnchorService(new ProjectService(neo4jService), neo4jService);
        const workingSet = bookmarkInput
          ? await anchorService.resolveAnchors(project, {
              nodeIds: bookmarkInput.workingSetNodeIds,
              paths: bookmarkInput.workingSetPaths,
            })
          : null;
        const anchors = noteInput
          ? await anchorService.resolveAnchors(project, {
              nodeIds: noteInput.aboutNodeIds,
              paths: noteInput.aboutPaths,
            })
          : null;

        const embeddingService = new SessionEmbeddingService(neo4jService, new EmbeddingsService());
        const result: Record<string, unknown> = { success: true, projectId: project.projectId, sessionId, agentId };

        if (bookmarkInput && workingSet) {
          const bookmarkId = generateBookmarkId();
          const bookmarkRows = await neo4jService.run(CREATE_BOOKMARK_QUERY, {
            bookmarkId,
            projectId: project.projectId,
            sessionId,
            agentId,
            summary: bookmarkInput.summary,
            workingSetNodeIds: workingSet.nodeIds,
            workingSetPaths: workingSet.paths,
            nodeRefs: workingSet.nodeRefs,
            sourceFileRefs: workingSet.sourceFileRefs,
            taskContext: bookmarkInput.taskContext,
            findings: bookmarkInput.findings,
            nextSteps: bookmarkInput.nextSteps,
            metadata: bookmarkInput.metadata,
          });

          if (bookmarkRows.length === 0) {
            return createErrorResponse(
              request.kind === 'both'
                ? 'Failed to create session bookmark; note was not saved.'
                : 'Failed to create session bookmark.',
            );
          }

          const bm = bookmarkRows[0];
          const linkedNodes = workingSet.nodeIds.length - workingSet.unresolvedNodeIds.length;
          const hasEmbedding = await embeddingService.embedBookmark({
            bookmarkId,
            projectId: project.projectId,
            taskContext: bookmarkInput.taskContext,
            summary: bookmarkInput.summary,
            findings: bookmarkInput.findings,
            nextSteps: bookmarkInput.nextSteps,
          });

          result.bookmark = {
            bookmarkId: bm.id,
            summary: bm.summary,
            taskContext: bm.taskContext,
            workingSetSize: workingSet.nodeIds.length,
            workingSetPaths: workingSet.paths,
            linkedNodes,
            unresolvedWorkingSetNodeIds: workingSet.unresolvedNodeIds,
            missingWorkingSetPaths: workingSet.missingPaths,
            hasEmbedding,
            createdAt: toNumber(bm.createdAt),
            message: `Session bookmark saved. ${linkedNodes} of ${workingSet.nodeIds.length} working set nodes linked in graph.`,
          };
        }

        if (noteInput && anchors) {
          const noteId = generateNoteId();
          const expiresAt =
            noteInput.expiresInHours != null ? Date.now() + noteInput.expiresInHours * 3600 * 1000 : null;

          const noteRows = await neo4jService.run(CREATE_SESSION_NOTE_QUERY, {
            noteId,
            projectId: project.projectId,
            sessionId,
            agentId,
            topic: noteInput.topic,
            content: noteInput.content,
            category: noteInput.category,
            severity: noteInput.severity,
            aboutNodeIds: anchors.nodeIds,
            aboutPaths: anchors.paths,
            aboutPathHashes: anchors.pathHashes,
            nodeRefs: anchors.nodeRefs,
            sourceFileRefs: anchors.sourceFileRefs,
            supersededBy: noteInput.supersededBy,
            supersedes: [...new Set(noteInput.supersedes)],
            expiresAt,
          });

          if (noteRows.length === 0) {
            return createErrorResponse('Failed to create session note.');
          }

          const hasEmbedding = await embeddingService.embedNote({
            noteId,
            projectId: project.projectId,
            topic: noteInput.topic,
            content: noteInput.content,
          });

          let chunkCount = 0;
          try {
            chunkCount = await saveSessionNoteChunks(neo4jService, project.projectId, noteId, noteInput.content);
          } catch (chunkErr) {
            await debugLog('Note chunk embedding failed; parent note was saved', { error: String(chunkErr), noteId });
          }

          result.note = {
            noteId,
            topic: noteInput.topic,
            category: noteInput.category,
            severity: noteInput.severity,
            hasEmbedding,
            chunkCount,
            aboutPaths: anchors.paths,
            unresolvedAboutNodeIds: anchors.unresolvedNodeIds,
            missingAboutPaths: anchors.missingPaths,
            ...(anchors.partiallyHashedPaths.length > 0 && {
              partiallyHashedAboutPaths: anchors.partiallyHashedPaths,
            }),
            expiresAt: expiresAt != null ? new Date(expiresAt).toISOString() : null,
            ...(noteInput.supersedes.length > 0 && {
              supersedes: { marked: noteRows[0].markedIds, notFound: noteRows[0].notFoundIds },
            }),
          };
        }

        result.type = request.kind;

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        if (error instanceof InvalidProjectInputError) return createErrorResponse(error);
        await debugLog('Session save error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
