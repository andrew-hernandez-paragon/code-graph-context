/**
 * Create Project Tool
 * Registers a directory or a named collection as a project that can hold memories
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { InvalidProjectInputError, ProjectService } from '../../core/projects/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  kind: z
    .enum(['directory', 'collection'])
    .describe(
      "'directory' for an existing local directory that is not parsed; 'collection' for memories with no directory",
    ),
  name: z.string().optional().describe('Collection name (required); for a directory, defaults to the directory name'),
  path: z.string().optional().describe('Existing directory path (required for kind directory)'),
  description: z.string().optional().describe('What belongs in this project (required for a collection)'),
});

export const createCreateProjectTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.createProject,
    {
      title: TOOL_METADATA[TOOL_NAMES.createProject].title,
      description: TOOL_METADATA[TOOL_NAMES.createProject].description,
      annotations: TOOL_METADATA[TOOL_NAMES.createProject].annotations,
      inputSchema: inputSchema.shape,
    },
    async ({ kind, name, path, description }) => {
      const neo4jService = new Neo4jService();
      try {
        const projectService = new ProjectService(neo4jService);

        if (kind === 'directory') {
          if (!path) {
            throw new InvalidProjectInputError("kind 'directory' needs a path to an existing directory.");
          }
          const { project, created } = await projectService.registerDirectory({ path, name, description });
          return createSuccessResponse(JSON.stringify({ created, project }, null, 2));
        }

        if (!name) {
          throw new InvalidProjectInputError("kind 'collection' needs a name, for example 'on-call'.");
        }
        const { project, created } = await projectService.createCollection({ name, description: description ?? '' });
        return createSuccessResponse(JSON.stringify({ created, project }, null, 2));
      } catch (error) {
        await debugLog('Create project error', { error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
