import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { SwarmAdvanceHandler } from '../handlers/swarm/index.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

export const createSwarmAdvanceTaskTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmAdvanceTask,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmAdvanceTask].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmAdvanceTask].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        taskId: z.string().describe('Task ID to advance'),
        agentId: z.string().describe('Your agent identifier'),
        force: z.boolean().optional().default(false).describe('Force start from stuck claimed or available state'),
        reason: z.string().optional().describe('Reason for force starting'),
      },
    },
    async ({ projectId, taskId, agentId, force = false, reason }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        if (force) {
          const { error, data } = await new SwarmAdvanceHandler(neo4jService).forceStart(
            resolvedProjectId,
            taskId,
            agentId,
            reason,
          );

          if (error) {
            return createErrorResponse(
              `Cannot force_start task ${taskId}. ` +
                (data
                  ? `Current state: ${data.status}, claimedBy: ${data.claimedBy || 'none'}. ` +
                    `force_start requires status=claimed|available and you must be the claimant.`
                  : 'Task not found.'),
            );
          }

          return createSuccessResponse(
            JSON.stringify({ action: 'force_started', taskId: data.id, status: 'in_progress' }),
          );
        }

        const { error, data } = await new SwarmAdvanceHandler(neo4jService).start(resolvedProjectId, taskId, agentId);

        if (error) {
          return createErrorResponse(
            `Cannot start task ${taskId}. ` +
              (data
                ? `Current state: ${data.status}, claimedBy: ${data.claimedBy || 'none'}. ` +
                  `Tip: Use force=true to recover from stuck claimed state, ` +
                  `or use swarm_release_task to give up the task.`
                : 'Task not found.'),
          );
        }

        return createSuccessResponse(JSON.stringify({ action: 'started', taskId: data.id, status: 'in_progress' }));
      } catch (error) {
        await debugLog('Swarm advance task error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
