import { Neo4jService } from '../../../storage/neo4j/neo4j.service.js';

import { GET_TASK_STATE_QUERY } from './queries.js';

/**
 * Query to abandon a task — releases it with tracking for debugging.
 * More explicit than release: tracks abandon history (count, previous claimant).
 */
const ABANDON_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.claimedBy = $agentId
    AND t.status IN ['claimed', 'in_progress']

  // Track abandon history
  SET t.status = 'available',
      t.previousClaimedBy = t.claimedBy,
      t.claimedBy = null,
      t.claimedAt = null,
      t.startedAt = null,
      t.updatedAt = timestamp(),
      t.abandonedBy = $agentId,
      t.abandonedAt = timestamp(),
      t.abandonReason = $reason,
      t.abandonCount = COALESCE(t.abandonCount, 0) + 1

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.abandonCount as abandonCount,
         t.abandonReason as abandonReason
`;

export class SwarmAbandonHandler {
  constructor(private readonly neo4jService: Neo4jService) {}

  async abandon(projectId: string, taskId: string, agentId: string, reason?: string) {
    const result = await this.neo4jService.run(ABANDON_TASK_QUERY, {
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

    const row = result[0];
    const abandonCount = typeof row.abandonCount === 'object' ? row.abandonCount.toNumber() : row.abandonCount;

    return {
      error: false as const,
      data: {
        id: row.id,
        title: row.title,
        status: row.status,
        abandonCount,
        abandonReason: row.abandonReason,
      },
    };
  }
}
