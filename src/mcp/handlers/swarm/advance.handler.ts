import { Neo4jService } from '../../../storage/neo4j/neo4j.service.js';

import { GET_TASK_STATE_QUERY } from './queries.js';

/**
 * Query to start working on a claimed task (transition to in_progress)
 */
const START_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status = 'claimed' AND t.claimedBy = $agentId

  SET t.status = 'in_progress',
      t.startedAt = timestamp(),
      t.updatedAt = timestamp()

  RETURN t.id as id,
         t.status as status,
         t.claimedBy as claimedBy,
         t.startedAt as startedAt
`;

/**
 * Query to force-start a task stuck in claimed state.
 * Allows recovery when the normal start action fails.
 */
const FORCE_START_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.claimedBy = $agentId
    AND t.status IN ['claimed', 'available']

  SET t.status = 'in_progress',
      t.claimedBy = $agentId,
      t.claimedAt = COALESCE(t.claimedAt, timestamp()),
      t.startedAt = timestamp(),
      t.updatedAt = timestamp(),
      t.forceStarted = true,
      t.forceStartReason = $reason

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.claimedBy as claimedBy,
         t.startedAt as startedAt,
         t.forceStarted as forceStarted
`;

export class SwarmAdvanceHandler {
  constructor(private readonly neo4jService: Neo4jService) {}

  async start(projectId: string, taskId: string, agentId: string) {
    const result = await this.neo4jService.run(START_TASK_QUERY, {
      taskId,
      projectId,
      agentId,
    });

    if (result.length === 0) {
      const stateResult = await this.neo4jService.run(GET_TASK_STATE_QUERY, {
        taskId,
        projectId,
      });
      return { error: true as const, data: stateResult[0] };
    }

    return { error: false as const, data: result[0] };
  }

  async forceStart(projectId: string, taskId: string, agentId: string, reason?: string) {
    const result = await this.neo4jService.run(FORCE_START_QUERY, {
      taskId,
      projectId,
      agentId,
      reason: reason || 'Recovering from stuck state',
    });

    if (result.length === 0) {
      const stateResult = await this.neo4jService.run(GET_TASK_STATE_QUERY, {
        taskId,
        projectId,
      });
      return { error: true as const, data: stateResult[0] };
    }

    return { error: false as const, data: result[0] };
  }
}
