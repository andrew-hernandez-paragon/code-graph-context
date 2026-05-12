/**
 * stop_ingest_cursordiff_session MCP tool
 * Stops a running cursordiff fs-watch session by watchId or dataDir.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { cursordiffWatchManager } from '../services/cursordiff-watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  watchId: z
    .string()
    .optional()
    .describe('Watch ID returned by ingest_cursordiff_session (mode: watch)'),
  dataDir: z.string().optional().describe('Data directory of the watcher to stop (alternative to watchId)'),
});

export const createStopIngestCursordiffSessionTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.stopIngestCursordiffSession,
    {
      title: TOOL_METADATA[TOOL_NAMES.stopIngestCursordiffSession].title,
      description: TOOL_METADATA[TOOL_NAMES.stopIngestCursordiffSession].description,
      inputSchema: inputSchema.shape,
    },
    async (args: z.infer<typeof inputSchema>) => {
      try {
        const { watchId, dataDir } = args;

        if (!watchId && !dataDir) {
          return createErrorResponse(
            new Error('Provide either watchId or dataDir. Use list_ingest_cursordiff_watchers to see active watchers.'),
          );
        }

        const idOrDir = (watchId ?? dataDir)!;

        await debugLog('stop_ingest_cursordiff_session called', { idOrDir });

        const info = cursordiffWatchManager.getWatcher(idOrDir);
        if (!info) {
          return createErrorResponse(
            new Error(
              `No active cursordiff watcher found for "${idOrDir}". Use list_ingest_cursordiff_watchers to see active watchers.`,
            ),
          );
        }

        const stopped = await cursordiffWatchManager.stopWatching(idOrDir);
        if (!stopped) {
          return createErrorResponse(new Error(`Failed to stop watcher "${idOrDir}"`));
        }

        const result = {
          stopped: true,
          watchId: info.watchId,
          dataDir: info.dataDir,
          rowsProcessed: info.rowsProcessed,
        };

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('stop_ingest_cursordiff_session error:', error);
        await debugLog('stop_ingest_cursordiff_session error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
