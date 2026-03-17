/**
 * Swarm Post Task Tool
 * Post a task to the blackboard for agents to claim and work on
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { TASK_PRIORITIES, TASK_TYPES, TaskPriority, generateTaskId } from './swarm-constants.js';

/**
 * Query to get node IDs for a file path (fallback when no nodeIds provided)
 * Uses ENDS WITH for flexible matching (handles absolute vs relative paths)
 */
const GET_NODES_FOR_FILE_QUERY = `
  MATCH (n)
  WHERE (n.filePath = $filePath OR n.filePath ENDS WITH $filePath)
    AND n.projectId = $projectId
    AND n.id IS NOT NULL
    AND NOT n:Pheromone
    AND NOT n:SwarmTask
  RETURN n.id AS id
  ORDER BY n.startLine
  LIMIT 20
`;

/**
 * Neo4j query to create a new SwarmTask node
 */
const CREATE_TASK_QUERY = `
  // Create the task node
  CREATE (t:SwarmTask {
    id: $taskId,
    projectId: $projectId,
    swarmId: $swarmId,
    title: $title,
    description: $description,
    type: $type,
    priority: $priority,
    priorityScore: $priorityScore,
    status: 'available',
    targetNodeIds: $targetNodeIds,
    targetFilePaths: $targetFilePaths,
    dependencies: $dependencies,
    createdBy: $createdBy,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    metadata: $metadata
  })

  // Link to target code nodes if they exist
  WITH t
  OPTIONAL MATCH (target)
  WHERE target.id IN $targetNodeIds
    AND target.projectId = $projectId
    AND NOT target:SwarmTask
    AND NOT target:Pheromone
  WITH t, collect(DISTINCT target) as targets
  FOREACH (target IN targets | MERGE (t)-[:TARGETS]->(target))

  // Link to dependency tasks if they exist
  WITH t
  OPTIONAL MATCH (dep:SwarmTask)
  WHERE dep.id IN $dependencies
    AND dep.projectId = $projectId
  WITH t, collect(DISTINCT dep) as deps
  FOREACH (dep IN deps | MERGE (t)-[:DEPENDS_ON]->(dep))

  // Return the created task
  RETURN t.id as id,
         t.projectId as projectId,
         t.swarmId as swarmId,
         t.title as title,
         t.description as description,
         t.type as type,
         t.priority as priority,
         t.priorityScore as priorityScore,
         t.status as status,
         t.targetNodeIds as targetNodeIds,
         t.targetFilePaths as targetFilePaths,
         t.dependencies as dependencies,
         t.createdBy as createdBy,
         t.createdAt as createdAt
`;

/**
 * Query to check if dependencies are met (all completed or no dependencies)
 */
const CHECK_DEPENDENCIES_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WITH t, collect(dep) as deps,
       [d IN collect(dep) WHERE d.status <> 'completed'] as incompleteDeps
  RETURN size(deps) as totalDeps,
         size(incompleteDeps) as incompleteDeps,
         [d IN incompleteDeps | {id: d.id, title: d.title, status: d.status}] as blockedBy
`;

/**
 * Query to update task status to blocked
 */
const SET_TASK_BLOCKED_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  SET t.status = 'blocked', t.updatedAt = timestamp()
  RETURN t.id as id
`;

export const createSwarmPostTaskTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmPostTask,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmPostTask].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmPostTask].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        swarmId: z.string().describe('Swarm ID for grouping related tasks'),
        title: z.string().min(1).max(200).describe('Short title for the task'),
        description: z.string().describe('Detailed description of what needs to be done'),
        type: z
          .enum(TASK_TYPES)
          .optional()
          .default('implement')
          .describe('Task type'),
        priority: z
          .enum(Object.keys(TASK_PRIORITIES) as [string, ...string[]])
          .optional()
          .default('normal')
          .describe('Task priority'),
        targetNodeIds: z
          .array(z.string())
          .optional()
          .default([])
          .describe('Code node IDs this task targets'),
        targetFilePaths: z
          .array(z.string())
          .optional()
          .default([])
          .describe('File paths this task affects'),
        dependencies: z
          .array(z.string())
          .optional()
          .default([])
          .describe('Task IDs that must complete before this task starts'),
        createdBy: z.string().describe('Agent ID creating this task'),
        metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
      },
    },
    async ({
      projectId,
      swarmId,
      title,
      description,
      type = 'implement',
      priority = 'normal',
      targetNodeIds = [],
      targetFilePaths = [],
      dependencies = [],
      createdBy,
      metadata,
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
        const taskId = generateTaskId();
        const priorityScore = TASK_PRIORITIES[priority as TaskPriority];
        const metadataJson = metadata ? JSON.stringify(metadata) : null;

        // Filter out null/undefined, then fallback to file query if empty
        let resolvedNodeIds = (targetNodeIds || []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        );
        if (resolvedNodeIds.length === 0 && targetFilePaths.length > 0) {
          for (const filePath of targetFilePaths) {
            const fileNodes = await neo4jService.run(GET_NODES_FOR_FILE_QUERY, {
              filePath,
              projectId: resolvedProjectId,
            });
            if (fileNodes.length > 0) {
              resolvedNodeIds = [...resolvedNodeIds, ...fileNodes.map((n) => n.id as string).filter(Boolean)];
            }
          }
        }

        // Create the task
        const result = await neo4jService.run(CREATE_TASK_QUERY, {
          taskId,
          projectId: resolvedProjectId,
          swarmId,
          title,
          description,
          type,
          priority,
          priorityScore,
          targetNodeIds: resolvedNodeIds,
          targetFilePaths,
          dependencies,
          createdBy,
          metadata: metadataJson,
        });

        if (result.length === 0) {
          return createErrorResponse('Failed to create task');
        }

        const task = result[0];

        // Check dependency status
        let dependencyStatus = { totalDeps: 0, incompleteDeps: 0, blockedBy: [] as any[] };
        if (dependencies.length > 0) {
          const depCheck = await neo4jService.run(CHECK_DEPENDENCIES_QUERY, {
            taskId,
            projectId: resolvedProjectId,
          });
          if (depCheck.length > 0) {
            dependencyStatus = {
              totalDeps:
                typeof depCheck[0].totalDeps === 'object' ? depCheck[0].totalDeps.toNumber() : depCheck[0].totalDeps,
              incompleteDeps:
                typeof depCheck[0].incompleteDeps === 'object'
                  ? depCheck[0].incompleteDeps.toNumber()
                  : depCheck[0].incompleteDeps,
              blockedBy: depCheck[0].blockedBy || [],
            };
          }
        }

        const isBlocked = dependencyStatus.incompleteDeps > 0;

        // Update task status to blocked if there are incomplete dependencies
        if (isBlocked) {
          await neo4jService.run(SET_TASK_BLOCKED_QUERY, {
            taskId,
            projectId: resolvedProjectId,
          });
        }

        return createSuccessResponse(
          JSON.stringify({
            success: true,
            task: {
              id: task.id,
              projectId: task.projectId,
              swarmId: task.swarmId,
              title: task.title,
              description: task.description,
              type: task.type,
              priority: task.priority,
              priorityScore: task.priorityScore,
              status: isBlocked ? 'blocked' : 'available',
              targetNodeIds: task.targetNodeIds,
              targetFilePaths: task.targetFilePaths,
              dependencies: task.dependencies,
              createdBy: task.createdBy,
              createdAt: typeof task.createdAt === 'object' ? task.createdAt.toNumber() : task.createdAt,
            },
            dependencyStatus: {
              isBlocked,
              ...dependencyStatus,
            },
            message: isBlocked
              ? `Task created but blocked by ${dependencyStatus.incompleteDeps} incomplete dependencies`
              : 'Task created and available for claiming',
          }),
        );
      } catch (error) {
        await debugLog('Swarm post task error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
