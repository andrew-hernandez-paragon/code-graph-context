/**
 * list_ingest_deliberate_watchers MCP tool
 * Returns all active deliberation fs-watch sessions with health observability fields.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { deliberateWatchManager } from '../services/deliberate-watch-manager.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

export const createListIngestDeliberateWatchersTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.listIngestDeliberateWatchers,
    {
      title: TOOL_METADATA[TOOL_NAMES.listIngestDeliberateWatchers].title,
      description: TOOL_METADATA[TOOL_NAMES.listIngestDeliberateWatchers].description,
      inputSchema: {},
    },
    async () => {
      try {
        const watchers = deliberateWatchManager.listWatchers();

        if (watchers.length === 0) {
          return createEmptyResponse(
            'No active deliberation watchers',
            'Use ingest_deliberate_session with mode="watch" to start one.',
          );
        }

        const result = {
          count: watchers.length,
          watchers: watchers.map((w) => ({
            watchId: w.watchId,
            dataDir: w.dataDir,
            rowsProcessed: w.rowsProcessed,
            isProcessing: w.isProcessing,
            lastActivityAt: w.lastActivityAt,
            lastErrorAt: w.lastErrorAt,
            lastError: w.lastError,
          })),
        };

        await debugLog('list_ingest_deliberate_watchers', { count: watchers.length });
        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('list_ingest_deliberate_watchers error:', error);
        await debugLog('list_ingest_deliberate_watchers error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
