/**
 * Start Watch Project Tool
 * Starts file watching for incremental graph updates
 */

import { constants as fsConstants } from 'fs';
import { access, stat } from 'fs/promises';
import { resolve } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ProjectService } from '../../core/projects/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { watchManager } from '../services/watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  projectPath: z.string().describe('Path to the TypeScript project root directory'),
  tsconfigPath: z.string().describe('Path to TypeScript project tsconfig.json file'),
  projectId: z
    .string()
    .optional()
    .describe('Optional codebase id or name; defaults to the codebase registered at projectPath'),
  debounceMs: z.number().optional().default(1000).describe('Debounce delay in milliseconds'),
});

export const createStartWatchProjectTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.startWatchProject,
    {
      title: TOOL_METADATA[TOOL_NAMES.startWatchProject].title,
      description: TOOL_METADATA[TOOL_NAMES.startWatchProject].description,
      annotations: TOOL_METADATA[TOOL_NAMES.startWatchProject].annotations,
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

        const neo4jService = new Neo4jService();
        let projectId: string;
        try {
          const project = await new ProjectService(neo4jService).findCodebase(args.projectId ?? resolvedProjectPath);
          if (!args.projectId && (project.path === null || resolve(project.path) !== resolvedProjectPath)) {
            return createErrorResponse(
              new Error(
                `Project path ${resolvedProjectPath} is not the root of codebase '${project.name}' (${project.projectId}), which is at ${project.path}. Pass that root as projectPath.`,
              ),
            );
          }
          projectId = project.projectId;
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
