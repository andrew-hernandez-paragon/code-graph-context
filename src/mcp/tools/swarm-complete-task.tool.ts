/**
 * Swarm Complete Task Tool
 * Mark a task as completed, failed, or needs_review with artifacts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

type Neo4jServiceType = InstanceType<typeof Neo4jService>;

/**
 * Query to complete a task with artifacts
 */
const COMPLETE_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['in_progress', 'claimed'] AND t.claimedBy = $agentId

  SET t.status = 'completed',
      t.completedAt = timestamp(),
      t.updatedAt = timestamp(),
      t.summary = $summary,
      t.artifacts = $artifacts,
      t.filesChanged = $filesChanged,
      t.linesAdded = $linesAdded,
      t.linesRemoved = $linesRemoved

  // Check for tasks that were blocked by this one
  WITH t
  OPTIONAL MATCH (waiting:SwarmTask)-[:DEPENDS_ON]->(t)
  WHERE waiting.status = 'blocked'

  // Check if waiting tasks now have all dependencies completed
  WITH t, collect(waiting) as waitingTasks

  // Unblock tasks that have all dependencies met
  UNWIND (CASE WHEN size(waitingTasks) = 0 THEN [null] ELSE waitingTasks END) as waiting
  OPTIONAL MATCH (waiting)-[:DEPENDS_ON]->(otherDep:SwarmTask)
  WHERE otherDep.status <> 'completed' AND otherDep.id <> t.id
  WITH t, waiting, count(otherDep) as remainingDeps

  // Update status for tasks with no remaining deps (but don't filter out the row)
  FOREACH (_ IN CASE WHEN waiting IS NOT NULL AND remainingDeps = 0 THEN [1] ELSE [] END |
    SET waiting.status = 'available', waiting.updatedAt = timestamp()
  )

  WITH t, CASE WHEN waiting IS NOT NULL AND remainingDeps = 0 THEN waiting.id ELSE null END as unblockedId
  WITH t, collect(unblockedId) as allUnblockedIds
  WITH t, [id IN allUnblockedIds WHERE id IS NOT NULL] as unblockedTaskIds

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.completedAt as completedAt,
         t.summary as summary,
         t.claimedBy as claimedBy,
         unblockedTaskIds
`;

/**
 * Query to mark task as failed
 */
const FAIL_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['in_progress', 'claimed'] AND t.claimedBy = $agentId

  SET t.status = 'failed',
      t.failedAt = timestamp(),
      t.updatedAt = timestamp(),
      t.failureReason = $reason,
      t.errorDetails = $errorDetails,
      t.retryable = $retryable

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.failedAt as failedAt,
         t.failureReason as failureReason,
         t.retryable as retryable
`;

/**
 * Query to mark task as needs_review
 * Accepts both in_progress and claimed states (agent may have done work without calling start)
 */
const REVIEW_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['in_progress', 'claimed'] AND t.claimedBy = $agentId

  SET t.status = 'needs_review',
      t.reviewRequestedAt = timestamp(),
      t.updatedAt = timestamp(),
      t.summary = $summary,
      t.artifacts = $artifacts,
      t.filesChanged = $filesChanged,
      t.reviewNotes = $reviewNotes

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.reviewRequestedAt as reviewRequestedAt,
         t.summary as summary,
         t.claimedBy as claimedBy
`;

/**
 * Query to approve a reviewed task (transition to completed)
 */
const APPROVE_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status = 'needs_review'

  SET t.status = 'completed',
      t.completedAt = timestamp(),
      t.updatedAt = timestamp(),
      t.approvedBy = $reviewerId,
      t.approvalNotes = $notes

  // Check for tasks that were blocked by this one
  WITH t
  OPTIONAL MATCH (waiting:SwarmTask)-[:DEPENDS_ON]->(t)
  WHERE waiting.status = 'blocked'

  // Check if waiting tasks now have all dependencies completed
  WITH t, collect(waiting) as waitingTasks

  // Unblock tasks that have all dependencies met
  UNWIND (CASE WHEN size(waitingTasks) = 0 THEN [null] ELSE waitingTasks END) as waiting
  OPTIONAL MATCH (waiting)-[:DEPENDS_ON]->(otherDep:SwarmTask)
  WHERE otherDep.status <> 'completed' AND otherDep.id <> t.id
  WITH t, waiting, count(otherDep) as remainingDeps

  // Update status for tasks with no remaining deps (but don't filter out the row)
  FOREACH (_ IN CASE WHEN waiting IS NOT NULL AND remainingDeps = 0 THEN [1] ELSE [] END |
    SET waiting.status = 'available', waiting.updatedAt = timestamp()
  )

  WITH t, CASE WHEN waiting IS NOT NULL AND remainingDeps = 0 THEN waiting.id ELSE null END as unblockedId
  WITH t, collect(unblockedId) as allUnblockedIds
  WITH t, [id IN allUnblockedIds WHERE id IS NOT NULL] as unblockedTaskIds

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.completedAt as completedAt,
         t.approvedBy as approvedBy,
         unblockedTaskIds
`;

/**
 * Query to reject a reviewed task (back to in_progress or failed)
 */
const REJECT_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status = 'needs_review'

  SET t.status = CASE WHEN $markAsFailed THEN 'failed' ELSE 'in_progress' END,
      t.updatedAt = timestamp(),
      t.rejectedBy = $reviewerId,
      t.rejectionNotes = $notes,
      t.rejectedAt = timestamp()

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.claimedBy as claimedBy,
         t.rejectionNotes as rejectionNotes
`;

/**
 * Query to retry a failed task
 */
const RETRY_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status = 'failed' AND t.retryable = true

  SET t.status = 'available',
      t.claimedBy = null,
      t.claimedAt = null,
      t.startedAt = null,
      t.failedAt = null,
      t.failureReason = null,
      t.errorDetails = null,
      t.updatedAt = timestamp(),
      t.retryCount = COALESCE(t.retryCount, 0) + 1

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.retryCount as retryCount
`;

/**
 * Query to get current task state for better error messages
 */
const GET_TASK_STATE_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.completedAt as completedAt,
         t.failedAt as failedAt,
         t.retryable as retryable,
         t.abandonCount as abandonCount
`;

/**
 * Helper to get task state and format error message
 */
async function getTaskStateError(
  neo4jService: Neo4jServiceType,
  taskId: string,
  projectId: string,
  action: string,
  agentId: string,
): Promise<string> {
  const stateResult = await neo4jService.run(GET_TASK_STATE_QUERY, {
    taskId,
    projectId,
  });

  if (stateResult.length === 0) {
    return `Task ${taskId} not found.`;
  }

  const state = stateResult[0];
  const claimedBy = state.claimedBy || 'none';
  const isOwner = claimedBy === agentId;

  let suggestion = '';
  if (action === 'complete' || action === 'fail') {
    if (state.status === 'available') {
      suggestion = 'You must claim the task first using swarm_claim_task, then start it or use startImmediately=true.';
    } else if (!isOwner) {
      suggestion = `Task is claimed by "${claimedBy}", not you.`;
    } else if (state.status === 'completed') {
      suggestion = 'Task is already completed.';
    } else if (state.status === 'failed') {
      suggestion = 'Task has failed. Use action="retry" to make it available again.';
    }
  } else if (action === 'request_review') {
    if (!isOwner) {
      suggestion = `Task is claimed by "${claimedBy}", not you.`;
    } else if (state.status === 'available') {
      suggestion = 'You must claim and work on the task first.';
    }
  }

  return (
    `Cannot ${action} task ${taskId}. ` +
    `Current state: ${state.status}, claimedBy: ${claimedBy}. ` +
    (suggestion || 'Check that you own the task and it is in a valid state.')
  );
}

export const createSwarmCompleteTaskTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmCompleteTask,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmCompleteTask].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmCompleteTask].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        taskId: z.string().describe('Task ID to complete'),
        agentId: z.string().describe('Your agent ID (must match who claimed the task)'),
        action: z
          .enum(['complete', 'fail', 'request_review', 'approve', 'reject', 'retry'])
          .describe('Action to take on the task'),
        summary: z.string().optional().describe('What was done (required for complete/request_review)'),
        artifacts: z
          .record(z.unknown())
          .optional()
          .describe('Artifacts produced by this task'),
        filesChanged: z.array(z.string()).optional().describe('Files modified'),
        linesAdded: z.number().int().optional().describe('Lines added'),
        linesRemoved: z.number().int().optional().describe('Lines removed'),
        reason: z.string().optional().describe('Failure reason (required for action=fail)'),
        errorDetails: z.string().optional().describe('Technical error details'),
        retryable: z.boolean().optional().default(true).describe('Allow retry after failure'),
        reviewNotes: z.string().optional().describe('Notes for the reviewer'),
        reviewerId: z.string().optional().describe('Reviewer ID (required for approve/reject)'),
        notes: z.string().optional().describe('Approval or rejection notes'),
        markAsFailed: z
          .boolean()
          .optional()
          .default(false)
          .describe('On reject, mark as failed instead of returning to in_progress'),
      },
    },
    async ({
      projectId,
      taskId,
      agentId,
      action,
      summary,
      artifacts,
      filesChanged,
      linesAdded,
      linesRemoved,
      reason,
      errorDetails,
      retryable = true,
      reviewNotes,
      reviewerId,
      notes,
      markAsFailed = false,
    }) => {
      const neo4jService = new Neo4jService();

      // Resolve project ID
      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        let result;

        switch (action) {
          case 'complete':
            if (!summary) {
              return createErrorResponse('summary is required for complete action');
            }

            result = await neo4jService.run(COMPLETE_TASK_QUERY, {
              taskId,
              projectId: resolvedProjectId,
              agentId,
              summary,
              artifacts: artifacts ? JSON.stringify(artifacts) : null,
              filesChanged: filesChanged || [],
              linesAdded: linesAdded || 0,
              linesRemoved: linesRemoved || 0,
            });

            if (result.length === 0) {
              const errorMsg = await getTaskStateError(neo4jService, taskId, resolvedProjectId, 'complete', agentId);
              return createErrorResponse(errorMsg);
            }

            return createSuccessResponse(
              JSON.stringify({
                action: 'completed',
                taskId: result[0].id,
                ...(result[0].unblockedTaskIds?.length > 0 && { unblockedTasks: result[0].unblockedTaskIds }),
              }),
            );

          case 'fail':
            if (!reason) {
              return createErrorResponse('reason is required for fail action');
            }

            result = await neo4jService.run(FAIL_TASK_QUERY, {
              taskId,
              projectId: resolvedProjectId,
              agentId,
              reason,
              errorDetails: errorDetails || null,
              retryable,
            });

            if (result.length === 0) {
              const errorMsg = await getTaskStateError(neo4jService, taskId, resolvedProjectId, 'fail', agentId);
              return createErrorResponse(errorMsg);
            }

            return createSuccessResponse(
              JSON.stringify({ action: 'failed', taskId: result[0].id, retryable: result[0].retryable }),
            );

          case 'request_review':
            if (!summary) {
              return createErrorResponse('summary is required for request_review action');
            }

            result = await neo4jService.run(REVIEW_TASK_QUERY, {
              taskId,
              projectId: resolvedProjectId,
              agentId,
              summary,
              artifacts: artifacts ? JSON.stringify(artifacts) : null,
              filesChanged: filesChanged || [],
              reviewNotes: reviewNotes || null,
            });

            if (result.length === 0) {
              const errorMsg = await getTaskStateError(
                neo4jService,
                taskId,
                resolvedProjectId,
                'request_review',
                agentId,
              );
              return createErrorResponse(errorMsg);
            }

            return createSuccessResponse(JSON.stringify({ action: 'review_requested', taskId: result[0].id }));

          case 'approve':
            if (!reviewerId) {
              return createErrorResponse('reviewerId is required for approve action');
            }

            result = await neo4jService.run(APPROVE_TASK_QUERY, {
              taskId,
              projectId: resolvedProjectId,
              reviewerId,
              notes: notes || null,
            });

            if (result.length === 0) {
              return createErrorResponse(
                `Cannot approve task ${taskId}. It may not exist or not be in needs_review status.`,
              );
            }

            return createSuccessResponse(
              JSON.stringify({
                action: 'approved',
                taskId: result[0].id,
                ...(result[0].unblockedTaskIds?.length > 0 && { unblockedTasks: result[0].unblockedTaskIds }),
              }),
            );

          case 'reject':
            if (!reviewerId) {
              return createErrorResponse('reviewerId is required for reject action');
            }

            result = await neo4jService.run(REJECT_TASK_QUERY, {
              taskId,
              projectId: resolvedProjectId,
              reviewerId,
              notes: notes || 'No notes provided',
              markAsFailed,
            });

            if (result.length === 0) {
              return createErrorResponse(
                `Cannot reject task ${taskId}. It may not exist or not be in needs_review status.`,
              );
            }

            return createSuccessResponse(
              JSON.stringify({ action: 'rejected', taskId: result[0].id, status: result[0].status }),
            );

          case 'retry':
            result = await neo4jService.run(RETRY_TASK_QUERY, {
              taskId,
              projectId: resolvedProjectId,
            });

            if (result.length === 0) {
              return createErrorResponse(
                `Cannot retry task ${taskId}. It may not exist, not be failed, or not be retryable.`,
              );
            }

            return createSuccessResponse(
              JSON.stringify({ action: 'retried', taskId: result[0].id, status: 'available' }),
            );

          default:
            return createErrorResponse(`Unknown action: ${action}`);
        }
      } catch (error) {
        await debugLog('Swarm complete task error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
