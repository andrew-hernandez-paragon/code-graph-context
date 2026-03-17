/**
 * Session Cleanup Tool
 * Remove expired notes and prune old bookmarks
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

/**
 * Count expired notes (for dry run)
 */
const COUNT_EXPIRED_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId = $projectId
    AND n.expiresAt IS NOT NULL
    AND n.expiresAt <= timestamp()
  RETURN count(n) AS count
`;

/**
 * Delete expired notes and their edges
 */
const DELETE_EXPIRED_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId = $projectId
    AND n.expiresAt IS NOT NULL
    AND n.expiresAt <= timestamp()
  WITH collect(n) AS toDelete
  WITH size(toDelete) AS cnt, toDelete
  FOREACH (n IN toDelete | DETACH DELETE n)
  RETURN cnt AS deleted
`;

/**
 * Find old bookmarks to prune (keeping N most recent per session)
 */
const COUNT_OLD_BOOKMARKS_QUERY = `
  MATCH (b:SessionBookmark)
  WHERE b.projectId = $projectId
  WITH b.sessionId AS sessionId, b
  ORDER BY b.createdAt DESC
  WITH sessionId, collect(b) AS bookmarks
  WHERE size(bookmarks) > $keepBookmarks
  UNWIND bookmarks[$keepBookmarks..] AS old
  RETURN count(old) AS count
`;

/**
 * Delete old bookmarks (keeping N most recent per session)
 */
const DELETE_OLD_BOOKMARKS_QUERY = `
  MATCH (b:SessionBookmark)
  WHERE b.projectId = $projectId
  WITH b.sessionId AS sessionId, b
  ORDER BY b.createdAt DESC
  WITH sessionId, collect(b) AS bookmarks
  WHERE size(bookmarks) > $keepBookmarks
  WITH reduce(all = [], bs IN collect(bookmarks[$keepBookmarks..]) | all + bs) AS toDelete
  WITH size(toDelete) AS cnt, toDelete
  FOREACH (b IN toDelete | DETACH DELETE b)
  RETURN cnt AS deleted
`;

export const createCleanupSessionTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.cleanupSession,
    {
      title: TOOL_METADATA[TOOL_NAMES.cleanupSession].title,
      description: TOOL_METADATA[TOOL_NAMES.cleanupSession].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        keepBookmarks: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(3)
          .describe('Recent bookmarks to keep per session'),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe('Preview what would be deleted without deleting'),
      },
    },
    async ({ projectId, keepBookmarks = 3, dryRun = false }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        const params = { projectId: resolvedProjectId, keepBookmarks };

        if (dryRun) {
          const [noteCount, bookmarkCount] = await Promise.all([
            neo4jService.run(COUNT_EXPIRED_NOTES_QUERY, params),
            neo4jService.run(COUNT_OLD_BOOKMARKS_QUERY, params),
          ]);

          const expiredNotes = noteCount[0]?.count ?? 0;
          const oldBookmarks = bookmarkCount[0]?.count ?? 0;
          const toNumber = (v: any) => (typeof v === 'object' && v?.toNumber ? v.toNumber() : v);

          return createSuccessResponse(
            JSON.stringify({
              dryRun: true,
              projectId: resolvedProjectId,
              wouldDelete: {
                expiredNotes: toNumber(expiredNotes),
                oldBookmarks: toNumber(oldBookmarks),
              },
              keepBookmarks,
              message:
                toNumber(expiredNotes) === 0 && toNumber(oldBookmarks) === 0
                  ? 'Nothing to clean up.'
                  : `Would delete ${toNumber(expiredNotes)} expired notes and ${toNumber(oldBookmarks)} old bookmarks.`,
            }),
          );
        }

        const [noteResult, bookmarkResult] = await Promise.all([
          neo4jService.run(DELETE_EXPIRED_NOTES_QUERY, params),
          neo4jService.run(DELETE_OLD_BOOKMARKS_QUERY, params),
        ]);

        const toNumber = (v: any) => (typeof v === 'object' && v?.toNumber ? v.toNumber() : v);
        const deletedNotes = toNumber(noteResult[0]?.deleted ?? 0);
        const deletedBookmarks = toNumber(bookmarkResult[0]?.deleted ?? 0);

        return createSuccessResponse(
          JSON.stringify({
            success: true,
            projectId: resolvedProjectId,
            deleted: {
              expiredNotes: deletedNotes,
              oldBookmarks: deletedBookmarks,
            },
            keepBookmarks,
            message:
              deletedNotes === 0 && deletedBookmarks === 0
                ? 'Nothing to clean up.'
                : `Deleted ${deletedNotes} expired notes and ${deletedBookmarks} old bookmarks.`,
          }),
        );
      } catch (error) {
        await debugLog('Cleanup session error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
