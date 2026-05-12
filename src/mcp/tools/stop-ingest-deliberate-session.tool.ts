/**
 * stop_ingest_deliberate_session MCP tool
 * Stops a running deliberation fs-watch session by watchId or dataDir.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { deliberateWatchManager } from '../services/deliberate-watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  watchId: z
    .string()
    .optional()
    .describe('Watch ID returned by ingest_deliberate_session (mode: watch)'),
  dataDir: z.string().optional().describe('Data directory of the watcher to stop (alternative to watchId)'),
});

export const createStopIngestDeliberateSessionTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.stopIngestDeliberateSession,
    {
      title: TOOL_METADATA[TOOL_NAMES.stopIngestDeliberateSession].title,
      description: TOOL_METADATA[TOOL_NAMES.stopIngestDeliberateSession].description,
      inputSchema: inputSchema.shape,
    },
    async (args: z.infer<typeof inputSchema>) => {
      try {
        const { watchId, dataDir } = args;

        if (!watchId && !dataDir) {
          return createErrorResponse(
            new Error(
              'Provide either watchId or dataDir. Use list_ingest_deliberate_watchers to see active watchers.',
            ),
          );
        }

        const idOrDir = (watchId ?? dataDir)!;

        await debugLog('stop_ingest_deliberate_session called', { idOrDir });

        const info = deliberateWatchManager.getWatcher(idOrDir);
        if (!info) {
          return createErrorResponse(
            new Error(
              `No active deliberate watcher found for "${idOrDir}". Use list_ingest_deliberate_watchers to see active watchers.`,
            ),
          );
        }

        const stopped = await deliberateWatchManager.stopWatching(idOrDir);
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
        console.error('stop_ingest_deliberate_session error:', error);
        await debugLog('stop_ingest_deliberate_session error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
