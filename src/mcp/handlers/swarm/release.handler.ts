import { Neo4jService } from '../../../storage/neo4j/neo4j.service.js';

import { GET_TASK_STATE_QUERY } from './queries.js';

/**
 * Query to release a claimed task (unclaim it)
 */
const RELEASE_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['claimed', 'in_progress'] AND t.claimedBy = $agentId

  SET t.status = 'available',
      t.claimedBy = null,
      t.claimedAt = null,
      t.startedAt = null,
      t.updatedAt = timestamp(),
      t.releaseReason = $reason

  RETURN t.id as id,
         t.title as title,
         t.status as status
`;

export class SwarmReleaseHandler {
  constructor(private readonly neo4jService: Neo4jService) {}

  async release(projectId: string, taskId: string, agentId: string, reason?: string) {
    const result = await this.neo4jService.run(RELEASE_TASK_QUERY, {
      taskId,
      projectId,
      agentId,
      reason: reason || 'No reason provided',
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
