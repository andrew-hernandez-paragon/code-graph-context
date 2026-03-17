/**
 * Start Watch Project Tool
 * Starts file watching for incremental graph updates
 */

import { constants as fsConstants } from 'fs';
import { access, stat } from 'fs/promises';
import { resolve } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { resolveProjectId } from '../../core/utils/project-id.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { watchManager } from '../services/watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  projectPath: z.string().describe('Path to the TypeScript project root directory'),
  tsconfigPath: z.string().describe('Path to TypeScript project tsconfig.json file'),
  projectId: z.string().optional().describe('Optional project ID override (auto-generated from path if omitted)'),
  debounceMs: z.number().optional().default(1000).describe('Debounce delay in milliseconds'),
});

export const createStartWatchProjectTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.startWatchProject,
    {
      title: TOOL_METADATA[TOOL_NAMES.startWatchProject].title,
      description: TOOL_METADATA[TOOL_NAMES.startWatchProject].description,
      inputSchema: inputSchema.shape,
    },
    async (args: z.infer<typeof inputSchema>) => {
      try {
        const { projectPath, tsconfigPath, debounceMs } = args;

        await debugLog('Starting file watcher', { projectPath, tsconfigPath, debounceMs });

        // Validate project path exists and is a directory
        const resolvedProjectPath = resolve(projectPath);
        try {
          await access(resolvedProjectPath, fsConstants.R_OK);
          const projectStats = await stat(resolvedProjectPath);
          if (!projectStats.isDirectory()) {
            return createErrorResponse(new Error(`Project path exists but is not a directory: ${resolvedProjectPath}`));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return createErrorResponse(new Error(`Project path does not exist: ${resolvedProjectPath}`));
          }
          throw error;
        }

        // Validate tsconfig exists and is a file
        const resolvedTsconfigPath = resolve(tsconfigPath);
        try {
          await access(resolvedTsconfigPath, fsConstants.R_OK);
          const tsconfigStats = await stat(resolvedTsconfigPath);
          if (!tsconfigStats.isFile()) {
            return createErrorResponse(new Error(`tsconfig path exists but is not a file: ${resolvedTsconfigPath}`));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return createErrorResponse(new Error(`tsconfig.json not found at: ${resolvedTsconfigPath}`));
          }
          throw error;
        }

        // Resolve project ID
        const projectId = args.projectId ?? (await resolveProjectId(resolvedProjectPath));

        // Check if project has been indexed
        const neo4jService = new Neo4jService();
        try {
          const result = await neo4jService.run(
            'MATCH (p:Project {projectId: $projectId}) RETURN p.projectId AS projectId',
            { projectId },
          );
          if (result.length === 0) {
            return createErrorResponse(
              new Error(
                `Project has not been indexed yet. Run parse_typescript_project first to create the initial graph, then start the watcher for incremental updates.`,
              ),
            );
          }
        } finally {
          await neo4jService.close();
        }

        // Start watching
        const watcherInfo = await watchManager.startWatching({
          projectPath: resolvedProjectPath,
          projectId,
          tsconfigPath: resolvedTsconfigPath,
          debounceMs,
        });

        await debugLog('File watcher started', { projectId, status: watcherInfo.status });

        const output = [
          `File watcher started successfully!`,
          ``,
          `Project: ${watcherInfo.projectPath}`,
          `Project ID: ${watcherInfo.projectId}`,
          `Status: ${watcherInfo.status}`,
          `Debounce: ${watcherInfo.debounceMs}ms`,
          ``,
          `The graph will be automatically updated when TypeScript files change.`,
          `Use stop_watch_project to stop watching.`,
          `Use list_watchers to see all active watchers.`,
        ].join('\n');

        return createSuccessResponse(output);
      } catch (error) {
        console.error('Start watch project error:', error);
        await debugLog('Start watch project error', { error });
        return createErrorResponse(error);
      }
    },
  );
};
