/**
 * list_ingest_cursordiff_watchers MCP tool
 * Returns all active cursordiff fs-watch sessions with health observability fields.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { cursordiffWatchManager } from '../services/cursordiff-watch-manager.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

export const createListIngestCursordiffWatchersTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.listIngestCursordiffWatchers,
    {
      title: TOOL_METADATA[TOOL_NAMES.listIngestCursordiffWatchers].title,
      description: TOOL_METADATA[TOOL_NAMES.listIngestCursordiffWatchers].description,
      inputSchema: {},
    },
    async () => {
      try {
        const watchers = cursordiffWatchManager.listWatchers();

        if (watchers.length === 0) {
          return createEmptyResponse(
            'No active cursordiff watchers',
            'Use ingest_cursordiff_session with mode="watch" to start one.',
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

        await debugLog('list_ingest_cursordiff_watchers', { count: watchers.length });
        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('list_ingest_cursordiff_watchers error:', error);
        await debugLog('list_ingest_cursordiff_watchers error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
