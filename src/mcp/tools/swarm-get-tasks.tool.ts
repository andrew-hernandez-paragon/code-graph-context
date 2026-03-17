/**
 * Swarm Get Tasks Tool
 * Query tasks from the blackboard with various filters
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { TASK_STATUSES, TASK_TYPES, TASK_PRIORITIES, TaskPriority } from './swarm-constants.js';

/**
 * Main query to get tasks with filters
 */
const GET_TASKS_QUERY = `
  MATCH (t:SwarmTask {projectId: $projectId})
  WHERE ($swarmId IS NULL OR t.swarmId = $swarmId)
    AND ($statuses IS NULL OR size($statuses) = 0 OR t.status IN $statuses)
    AND ($types IS NULL OR size($types) = 0 OR t.type IN $types)
    AND ($claimedBy IS NULL OR t.claimedBy = $claimedBy)
    AND ($createdBy IS NULL OR t.createdBy = $createdBy)
    AND ($minPriority IS NULL OR t.priorityScore >= $minPriority)

  // Get dependency info
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WITH t, collect({id: dep.id, title: dep.title, status: dep.status}) as dependencies

  // Get tasks blocked by this one
  OPTIONAL MATCH (blocked:SwarmTask)-[:DEPENDS_ON]->(t)
  WITH t, dependencies, collect({id: blocked.id, title: blocked.title, status: blocked.status}) as blockedTasks

  // Get target code nodes
  OPTIONAL MATCH (t)-[:TARGETS]->(target)
  WITH t, dependencies, blockedTasks,
       collect(DISTINCT {id: target.id, type: labels(target)[0], name: target.name, filePath: target.filePath}) as targets

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
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.completedAt as completedAt,
         t.createdBy as createdBy,
         t.createdAt as createdAt,
         t.summary as summary,
         t.metadata as metadata,
         dependencies,
         blockedTasks,
         [target IN targets WHERE target.id IS NOT NULL] as targets

  ORDER BY
    CASE WHEN $orderBy = 'priority' THEN t.priorityScore END DESC,
    CASE WHEN $orderBy = 'created' THEN t.createdAt END DESC,
    CASE WHEN $orderBy = 'updated' THEN t.updatedAt END DESC,
    t.priorityScore DESC,
    t.createdAt ASC

  SKIP toInteger($skip)
  LIMIT toInteger($limit)
`;

/**
 * Query to get task statistics for a swarm
 */
const GET_TASK_STATS_QUERY = `
  MATCH (t:SwarmTask {projectId: $projectId})
  WHERE ($swarmId IS NULL OR t.swarmId = $swarmId)

  WITH t.status as status, t.type as type, t.priority as priority,
       t.claimedBy as agent, count(t) as count

  RETURN status, type, priority, agent, count
  ORDER BY count DESC
`;

/**
 * Query to get a single task by ID with full details
 */
const GET_TASK_BY_ID_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})

  // Get dependencies
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WITH t, collect({
    id: dep.id,
    title: dep.title,
    status: dep.status,
    claimedBy: dep.claimedBy
  }) as dependencies

  // Get tasks blocked by this one
  OPTIONAL MATCH (blocked:SwarmTask)-[:DEPENDS_ON]->(t)
  WITH t, dependencies, collect({
    id: blocked.id,
    title: blocked.title,
    status: blocked.status
  }) as blockedTasks

  // Get target code nodes with more detail
  OPTIONAL MATCH (t)-[:TARGETS]->(target)
  WITH t, dependencies, blockedTasks,
       collect(DISTINCT {
         id: target.id,
         type: labels(target)[0],
         name: target.name,
         filePath: target.filePath,
         coreType: target.coreType,
         semanticType: target.semanticType
       }) as targets

  RETURN t {
    .*,
    dependencies: dependencies,
    blockedTasks: blockedTasks,
    targets: [target IN targets WHERE target.id IS NOT NULL]
  } as task
`;

/**
 * Query to get active workers from pheromones
 */
const GET_ACTIVE_WORKERS_QUERY = `
  MATCH (p:Pheromone {projectId: $projectId})
  WHERE ($swarmId IS NULL OR p.swarmId = $swarmId)
    AND p.type IN ['modifying', 'claiming']
  WITH p.agentId as agentId, p.type as type,
       max(p.timestamp) as lastActivity,
       count(p) as nodeCount
  RETURN agentId, type,
         lastActivity,
         nodeCount,
         duration.between(datetime({epochMillis: lastActivity}), datetime()).minutes as minutesSinceActivity
  ORDER BY lastActivity DESC
`;

/**
 * Query to get the dependency graph for visualization
 */
const GET_DEPENDENCY_GRAPH_QUERY = `
  MATCH (t:SwarmTask {projectId: $projectId})
  WHERE ($swarmId IS NULL OR t.swarmId = $swarmId)

  OPTIONAL MATCH (t)-[r:DEPENDS_ON]->(dep:SwarmTask)

  RETURN collect(DISTINCT {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    type: t.type,
    claimedBy: t.claimedBy
  }) as nodes,
  collect(DISTINCT CASE WHEN dep IS NOT NULL THEN {from: t.id, to: dep.id} END) as edges
`;

export const createSwarmGetTasksTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmGetTasks,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmGetTasks].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmGetTasks].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        swarmId: z.string().optional().describe('Filter by swarm ID'),
        taskId: z.string().optional().describe('Get a specific task by ID (returns full details)'),
        statuses: z.array(z.enum(TASK_STATUSES)).optional().describe('Filter by task statuses'),
        types: z.array(z.enum(TASK_TYPES)).optional().describe('Filter by task types'),
        claimedBy: z.string().optional().describe('Filter by claiming agent'),
        createdBy: z.string().optional().describe('Filter by creating agent'),
        minPriority: z
          .enum(Object.keys(TASK_PRIORITIES) as [string, ...string[]])
          .optional()
          .describe('Minimum priority level'),
        orderBy: z.enum(['priority', 'created', 'updated']).optional().default('priority').describe('Sort order'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Maximum tasks to return'),
        skip: z.number().int().min(0).optional().default(0).describe('Tasks to skip for pagination'),
        includeStats: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include aggregate statistics by status/type/agent'),
        includeDependencyGraph: z.boolean().optional().default(false).describe('Include dependency graph'),
      },
    },
    async ({
      projectId,
      swarmId,
      taskId,
      statuses,
      types,
      claimedBy,
      createdBy,
      minPriority,
      orderBy = 'priority',
      limit = 20,
      skip = 0,
      includeStats = false,
      includeDependencyGraph = false,
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
        // If taskId is provided, get single task with full details
        if (taskId) {
          const result = await neo4jService.run(GET_TASK_BY_ID_QUERY, {
            taskId,
            projectId: resolvedProjectId,
          });

          if (result.length === 0) {
            return createErrorResponse(`Task ${taskId} not found`);
          }

          const task = result[0].task;

          // Parse metadata if present
          if (task.metadata) {
            try {
              task.metadata = JSON.parse(task.metadata);
            } catch {
              // Keep as string if not valid JSON
            }
          }

          // Parse artifacts if present
          if (task.artifacts) {
            try {
              task.artifacts = JSON.parse(task.artifacts);
            } catch {
              // Keep as string if not valid JSON
            }
          }

          // Convert Neo4j integers
          const convertTimestamp = (ts: any) => (typeof ts === 'object' && ts?.toNumber ? ts.toNumber() : ts);

          task.createdAt = convertTimestamp(task.createdAt);
          task.updatedAt = convertTimestamp(task.updatedAt);
          task.claimedAt = convertTimestamp(task.claimedAt);
          task.startedAt = convertTimestamp(task.startedAt);
          task.completedAt = convertTimestamp(task.completedAt);

          return createSuccessResponse(JSON.stringify({ success: true, task }));
        }

        // Get list of tasks
        const minPriorityScore = minPriority ? TASK_PRIORITIES[minPriority as TaskPriority] : null;

        const tasksResult = await neo4jService.run(GET_TASKS_QUERY, {
          projectId: resolvedProjectId,
          swarmId: swarmId || null,
          statuses: statuses || null,
          types: types || null,
          claimedBy: claimedBy || null,
          createdBy: createdBy || null,
          minPriority: minPriorityScore,
          orderBy,
          limit: Math.floor(limit),
          skip: Math.floor(skip),
        });

        const convertTimestamp = (ts: any) => (typeof ts === 'object' && ts?.toNumber ? ts.toNumber() : ts);

        const tasks = tasksResult.map((t: any) => {
          // Parse metadata if present
          let metadata = t.metadata;
          if (metadata) {
            try {
              metadata = JSON.parse(metadata);
            } catch {
              // Keep as string
            }
          }

          return {
            id: t.id,
            projectId: t.projectId,
            swarmId: t.swarmId,
            title: t.title,
            description: t.description,
            type: t.type,
            priority: t.priority,
            priorityScore: t.priorityScore,
            status: t.status,
            targetNodeIds: t.targetNodeIds,
            targetFilePaths: t.targetFilePaths,
            claimedBy: t.claimedBy,
            claimedAt: convertTimestamp(t.claimedAt),
            startedAt: convertTimestamp(t.startedAt),
            completedAt: convertTimestamp(t.completedAt),
            createdBy: t.createdBy,
            createdAt: convertTimestamp(t.createdAt),
            summary: t.summary,
            metadata,
            dependencies: t.dependencies?.filter((d: any) => d.id !== null) || [],
            blockedTasks: t.blockedTasks?.filter((d: any) => d.id !== null) || [],
            targets: t.targets || [],
          };
        });

        const response: any = {
          success: true,
          tasks,
          pagination: {
            skip,
            limit,
            returned: tasks.length,
            hasMore: tasks.length === limit,
          },
          filters: {
            swarmId: swarmId || 'all',
            statuses: statuses || 'all',
            types: types || 'all',
            claimedBy: claimedBy || 'any',
            minPriority: minPriority || 'any',
          },
        };

        // Include statistics if requested
        if (includeStats) {
          const statsResult = await neo4jService.run(GET_TASK_STATS_QUERY, {
            projectId: resolvedProjectId,
            swarmId: swarmId || null,
          });

          const stats = {
            byStatus: {} as Record<string, number>,
            byType: {} as Record<string, number>,
            byPriority: {} as Record<string, number>,
            byAgent: {} as Record<string, number>,
            total: 0,
          };

          for (const row of statsResult) {
            const count = typeof row.count === 'object' ? row.count.toNumber() : row.count;

            if (row.status) {
              stats.byStatus[row.status] = (stats.byStatus[row.status] || 0) + count;
            }
            if (row.type) {
              stats.byType[row.type] = (stats.byType[row.type] || 0) + count;
            }
            if (row.priority) {
              stats.byPriority[row.priority] = (stats.byPriority[row.priority] || 0) + count;
            }
            if (row.agent) {
              stats.byAgent[row.agent] = (stats.byAgent[row.agent] || 0) + count;
            }
          }

          stats.total = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);

          // Calculate progress metrics
          const completed = stats.byStatus['completed'] ?? 0;
          const failed = stats.byStatus['failed'] ?? 0;
          const inProgress = stats.byStatus['in_progress'] ?? 0;
          const available = stats.byStatus['available'] ?? 0;
          const blocked = stats.byStatus['blocked'] ?? 0;
          const done = completed + failed;

          response.stats = stats;
          response.progress = {
            completed,
            failed,
            inProgress,
            available,
            blocked,
            total: stats.total,
            percentComplete: stats.total > 0 ? Math.round((done / stats.total) * 100) : 0,
            isComplete: done === stats.total && stats.total > 0,
            summary:
              stats.total === 0
                ? 'No tasks'
                : `${completed}/${stats.total} completed (${Math.round((done / stats.total) * 100)}%)`,
          };

          // Get active workers from pheromones
          const workersResult = await neo4jService.run(GET_ACTIVE_WORKERS_QUERY, {
            projectId: resolvedProjectId,
            swarmId: swarmId || null,
          });

          response.activeWorkers = workersResult.map((w: any) => ({
            agentId: w.agentId,
            status: w.type === 'modifying' ? 'working' : 'claiming',
            lastActivity: typeof w.lastActivity === 'object' ? w.lastActivity.toNumber() : w.lastActivity,
            nodesBeingWorked: typeof w.nodeCount === 'object' ? w.nodeCount.toNumber() : w.nodeCount,
            minutesSinceActivity:
              typeof w.minutesSinceActivity === 'object' ? w.minutesSinceActivity.toNumber() : w.minutesSinceActivity,
          }));
        }

        // Include dependency graph if requested
        if (includeDependencyGraph) {
          const graphResult = await neo4jService.run(GET_DEPENDENCY_GRAPH_QUERY, {
            projectId: resolvedProjectId,
            swarmId: swarmId || null,
          });

          if (graphResult.length > 0) {
            response.dependencyGraph = {
              nodes: graphResult[0].nodes || [],
              edges: (graphResult[0].edges || []).filter((e: any) => e !== null),
            };
          }
        }

        return createSuccessResponse(JSON.stringify(response, null, 2));
      } catch (error) {
        await debugLog('Swarm get tasks error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
