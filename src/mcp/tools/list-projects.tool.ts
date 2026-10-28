/**
 * List Projects Tool
 * Lists every project (codebase, directory or collection) with its memory counts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { PROJECT_KINDS, ProjectService } from '../../core/projects/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

export const createListProjectsTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.listProjects,
    {
      title: TOOL_METADATA[TOOL_NAMES.listProjects].title,
      description: TOOL_METADATA[TOOL_NAMES.listProjects].description,
      annotations: TOOL_METADATA[TOOL_NAMES.listProjects].annotations,
      inputSchema: {
        kinds: z
          .array(z.enum(PROJECT_KINDS))
          .optional()
          .describe('Only list projects of these kinds (default: all kinds)'),
      },
    },
    async ({ kinds }) => {
      const neo4jService = new Neo4jService();
      try {
        const projects = await new ProjectService(neo4jService).list(kinds);

        if (projects.length === 0) {
          return createEmptyResponse(
            kinds ? `No projects of kind ${kinds.join(', ')} found` : 'No projects found in the database',
            'Call create_project to add a directory or collection of memories, or parse_typescript_project to add a codebase.',
          );
        }

        return createSuccessResponse(JSON.stringify({ projects }, null, 2));
      } catch (error) {
        console.error('List projects error:', error);
        await debugLog('List projects error', { error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
