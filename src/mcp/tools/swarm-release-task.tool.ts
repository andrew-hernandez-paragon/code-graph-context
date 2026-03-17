import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';
import { SwarmReleaseHandler, SwarmAbandonHandler } from '../handlers/swarm/index.js';

export const createSwarmReleaseTaskTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmReleaseTask,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmReleaseTask].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmReleaseTask].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        taskId: z.string().describe('Task ID to release'),
        agentId: z.string().describe('Your agent identifier'),
        reason: z.string().optional().describe('Reason for releasing or abandoning'),
        trackAbandonment: z
          .boolean()
          .optional()
          .default(false)
          .describe('Track as abandonment for retry metrics'),
      },
    },
    async ({ projectId, taskId, agentId, reason, trackAbandonment = false }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        if (trackAbandonment) {
          const { error, data } = await new SwarmAbandonHandler(neo4jService).abandon(
            resolvedProjectId,
            taskId,
            agentId,
            reason,
          );

          if (error) {
            return createErrorResponse(
              `Cannot abandon task ${taskId}. ` +
                (data ? `Current state: ${data.status}, claimedBy: ${data.claimedBy || 'none'}` : 'Task not found.'),
            );
          }

          return createSuccessResponse(
            JSON.stringify({ action: 'abandoned', taskId: data.id, abandonCount: data.abandonCount }),
          );
        }

        const { error, data } = await new SwarmReleaseHandler(neo4jService).release(
          resolvedProjectId,
          taskId,
          agentId,
          reason,
        );

        if (error) {
          return createErrorResponse(
            `Cannot release task ${taskId}. ` +
              (data ? `Current state: ${data.status}, claimedBy: ${data.claimedBy || 'none'}` : 'Task not found.'),
          );
        }

        return createSuccessResponse(
          JSON.stringify({
            action: 'released',
            taskId: data.id,
            ...(data.abandonCount != null && { abandonCount: data.abandonCount }),
          }),
        );
      } catch (error) {
        await debugLog('Swarm release task error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
