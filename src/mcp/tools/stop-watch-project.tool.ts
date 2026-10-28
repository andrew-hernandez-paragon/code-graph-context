/**
 * Stop Watch Project Tool
 * Stops file watching for a project
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { TOOL_NAMES, TOOL_METADATA, PROJECT_ID_DESCRIPTION } from '../constants.js';
import { watchManager } from '../services/watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  projectId: z.string().describe(PROJECT_ID_DESCRIPTION.codebase),
});

export const createStopWatchProjectTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.stopWatchProject,
    {
      title: TOOL_METADATA[TOOL_NAMES.stopWatchProject].title,
      description: TOOL_METADATA[TOOL_NAMES.stopWatchProject].description,
      annotations: TOOL_METADATA[TOOL_NAMES.stopWatchProject].annotations,
      inputSchema: inputSchema.shape,
    },
    async (args: z.infer<typeof inputSchema>) => {
      try {
        const { projectId } = args;

        await debugLog('Stopping file watcher', { projectId });

        // Get watcher info before stopping (for response)
        const watcherInfo = watchManager.getWatcherInfo(projectId);

        if (!watcherInfo) {
          return createErrorResponse(
            new Error(`No active watcher found for project: ${projectId}. Use list_watchers to see active watchers.`),
          );
        }

        // Stop watching
        const stopped = await watchManager.stopWatching(projectId);

        if (!stopped) {
          return createErrorResponse(new Error(`Failed to stop watcher for project: ${projectId}`));
        }

        await debugLog('File watcher stopped', { projectId });

        const output = [
          `File watcher stopped successfully!`,
          ``,
          `Project: ${watcherInfo.projectPath}`,
          `Project ID: ${watcherInfo.projectId}`,
          ``,
          `The graph will no longer be automatically updated for this project.`,
          `Use start_watch_project to start watching again.`,
        ].join('\n');

        return createSuccessResponse(output);
      } catch (error) {
        console.error('Stop watch project error:', error);
        await debugLog('Stop watch project error', { error });
        return createErrorResponse(error);
      }
    },
  );
};
