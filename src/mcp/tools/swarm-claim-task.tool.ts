/**
 * Swarm Claim Task Tool
 * Allow an agent to claim an available task from the blackboard
 *
 * Phase 1 improvements:
 * - Atomic claim_and_start action (eliminates race window)
 * - Retry logic on race loss
 * - Recovery actions (abandon, force_start)
 *
 * Phase 2 refactor:
 * - Handlers extracted to src/mcp/handlers/swarm/
 * - Shared queries centralized in queries.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { TASK_TYPES, TASK_PRIORITIES } from './swarm-constants.js';
import { PENDING_MESSAGES_FOR_AGENT_QUERY, AUTO_ACKNOWLEDGE_QUERY } from './swarm-message.tool.js';
import {
  SwarmClaimHandler,
  SwarmReleaseHandler,
  SwarmAbandonHandler,
  SwarmAdvanceHandler,
} from '../handlers/swarm/index.js';

export const createSwarmClaimTaskTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmClaimTask,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmClaimTask].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmClaimTask].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        swarmId: z.string().describe('Swarm ID to find tasks in'),
        agentId: z.string().describe('Your unique agent identifier'),
        taskId: z
          .string()
          .optional()
          .describe('Specific task ID to claim (if omitted, claims highest priority available task)'),
        types: z
          .array(z.enum(TASK_TYPES))
          .optional()
          .describe('Filter by task types'),
        minPriority: z
          .enum(Object.keys(TASK_PRIORITIES) as [string, ...string[]])
          .optional()
          .describe('Minimum priority when auto-selecting'),
        action: z
          .enum(['claim', 'claim_and_start', 'start', 'release', 'abandon', 'force_start'])
          .optional()
          .default('claim_and_start')
          .describe(
            'claim_and_start: atomic claim+start (recommended); release/abandon: give up task; force_start: recover stuck state',
          ),
        releaseReason: z.string().optional().describe('Reason for releasing or abandoning'),
      },
    },
    async ({ projectId, swarmId, agentId, taskId, types, minPriority, action = 'claim_and_start', releaseReason }) => {
      const neo4jService = new Neo4jService();

      // Resolve project ID
      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Handle release action
        if (action === 'release') {
          if (!taskId) {
            return createErrorResponse('taskId is required for release action');
          }

          const { error, data } = await new SwarmReleaseHandler(neo4jService).release(
            resolvedProjectId,
            taskId,
            agentId,
            releaseReason,
          );

          if (error) {
            return createErrorResponse(
              `Cannot release task ${taskId}. ` +
                (data ? `Current state: ${data.status}, claimedBy: ${data.claimedBy || 'none'}` : 'Task not found.'),
            );
          }

          return createSuccessResponse(JSON.stringify({ action: 'released', taskId: data.id }));
        }

        // Handle abandon action (release with tracking)
        if (action === 'abandon') {
          if (!taskId) {
            return createErrorResponse('taskId is required for abandon action');
          }

          const { error, data } = await new SwarmAbandonHandler(neo4jService).abandon(
            resolvedProjectId,
            taskId,
            agentId,
            releaseReason,
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

        // Handle force_start action (recovery from stuck claimed state)
        if (action === 'force_start') {
          if (!taskId) {
            return createErrorResponse('taskId is required for force_start action');
          }

          const { error, data } = await new SwarmAdvanceHandler(neo4jService).forceStart(
            resolvedProjectId,
            taskId,
            agentId,
            releaseReason,
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

        // Handle start action
        if (action === 'start') {
          if (!taskId) {
            return createErrorResponse('taskId is required for start action');
          }

          const { error, data } = await new SwarmAdvanceHandler(neo4jService).start(
            resolvedProjectId,
            taskId,
            agentId,
          );

          if (error) {
            return createErrorResponse(
              `Cannot start task ${taskId}. ` +
                (data
                  ? `Current state: ${data.status}, claimedBy: ${data.claimedBy || 'none'}. ` +
                    `Tip: Use action="force_start" to recover from stuck claimed state, ` +
                    `or action="abandon" to release the task.`
                  : 'Task not found.'),
            );
          }

          return createSuccessResponse(
            JSON.stringify({ action: 'started', taskId: data.id, status: 'in_progress' }),
          );
        }

        // Handle claim and claim_and_start actions
        const claimHandler = new SwarmClaimHandler(neo4jService);
        const targetStatus = action === 'claim_and_start' ? 'in_progress' : 'claimed';

        let claimResult;

        if (taskId) {
          claimResult = await claimHandler.claimById(resolvedProjectId, taskId, agentId, targetStatus);

          if (claimResult.error) {
            return createErrorResponse(
              `Cannot claim task ${taskId}. ` +
                (claimResult.data
                  ? `Current state: ${claimResult.data.status}, claimedBy: ${claimResult.data.claimedBy || 'none'}`
                  : 'Task not found or has incomplete dependencies.'),
            );
          }
        } else {
          claimResult = await claimHandler.claimNext(resolvedProjectId, swarmId, agentId, targetStatus, {
            types: types || null,
            minPriority: minPriority || null,
          });

          if (!claimResult.data) {
            return createSuccessResponse(
              JSON.stringify({ action: 'no_tasks', retryAttempts: claimResult.retryAttempts }),
            );
          }
        }

        const task = claimResult.data;
        const actionLabel = action === 'claim_and_start' ? 'claimed_and_started' : 'claimed';

        // Extract valid targets (resolved via :TARGETS relationship)
        const resolvedTargets = (task.targets || [])
          .filter((t: { id?: string }) => t?.id)
          .map((t: { id: string; name?: string; filePath?: string }) => ({
            nodeId: t.id,
            name: t.name,
            filePath: t.filePath,
          }));

        // Fetch pending messages for this agent (direct delivery on claim)
        let pendingMessages: any[] = [];
        try {
          const msgResult = await neo4jService.run(PENDING_MESSAGES_FOR_AGENT_QUERY, {
            projectId: resolvedProjectId,
            swarmId,
            agentId,
          });

          if (msgResult.length > 0) {
            pendingMessages = msgResult.map((m: any) => {
              const ts =
                typeof m.timestamp === 'object' && m.timestamp?.toNumber ? m.timestamp.toNumber() : m.timestamp;
              return {
                id: m.id,
                from: m.fromAgentId,
                category: m.category,
                content: m.content,
                taskId: m.taskId ?? undefined,
                filePaths: m.filePaths?.length > 0 ? m.filePaths : undefined,
                age: ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : null,
              };
            });

            // Auto-acknowledge delivered messages
            const deliveredIds = pendingMessages.map((m: any) => m.id);
            await neo4jService.run(AUTO_ACKNOWLEDGE_QUERY, {
              messageIds: deliveredIds,
              agentId,
            });
          }
        } catch (msgError) {
          // Non-fatal: message delivery failure shouldn't block task claim
          await debugLog('Swarm claim task: message delivery failed (non-fatal)', { error: String(msgError) });
        }

        // Slim response - only essential fields for agent to do work
        return createSuccessResponse(
          JSON.stringify({
            action: actionLabel,
            task: {
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
              type: task.type,
              // Prefer resolved targets over stored nodeIds (resolved targets are from graph relationships)
              targets: resolvedTargets.length > 0 ? resolvedTargets : undefined,
              targetNodeIds: task.targetNodeIds?.length > 0 ? task.targetNodeIds : undefined,
              targetFilePaths: task.targetFilePaths,
              ...(task.dependencies?.length > 0 && { dependencies: task.dependencies }),
            },
            ...(pendingMessages.length > 0 && { messages: pendingMessages }),
            ...(claimResult.retryAttempts > 0 && { retryAttempts: claimResult.retryAttempts }),
          }),
        );
      } catch (error) {
        await debugLog('Swarm claim task error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
