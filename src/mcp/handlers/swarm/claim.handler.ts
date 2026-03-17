import { Neo4jService } from '../../../storage/neo4j/neo4j.service.js';
import { TASK_PRIORITIES, TaskPriority } from '../../tools/swarm-constants.js';

import { CLAIM_TASK_BY_ID_QUERY, CLAIM_NEXT_TASK_QUERY, GET_TASK_STATE_QUERY } from './queries.js';

/** Maximum retries when racing for a task */
const MAX_CLAIM_RETRIES = 3;
/** Delay between retries (ms) */
const RETRY_DELAY_BASE_MS = 50;

export class SwarmClaimHandler {
  constructor(private readonly neo4jService: Neo4jService) {}

  /**
   * Claim a specific task by ID.
   */
  async claimById(projectId: string, taskId: string, agentId: string, targetStatus: 'claimed' | 'in_progress') {
    const result = await this.neo4jService.run(CLAIM_TASK_BY_ID_QUERY, {
      taskId,
      projectId,
      agentId,
      targetStatus,
    });

    if (result.length === 0) {
      const stateResult = await this.neo4jService.run(GET_TASK_STATE_QUERY, {
        taskId,
        projectId,
      });
      return { error: true as const, data: stateResult[0], retryAttempts: 0 };
    }

    return { error: false as const, data: result[0], retryAttempts: 0 };
  }

  /**
   * Auto-select and claim the highest priority available task.
   * Includes retry logic with exponential backoff for race conditions.
   */
  async claimNext(
    projectId: string,
    swarmId: string,
    agentId: string,
    targetStatus: 'claimed' | 'in_progress',
    filters?: { types?: string[] | null; minPriority?: string | null },
  ) {
    const minPriorityScore = filters?.minPriority ? TASK_PRIORITIES[filters.minPriority as TaskPriority] : null;

    let result: any[] = [];
    let retryCount = 0;

    while (retryCount < MAX_CLAIM_RETRIES) {
      result = await this.neo4jService.run(CLAIM_NEXT_TASK_QUERY, {
        projectId,
        swarmId,
        agentId,
        types: filters?.types || null,
        minPriority: minPriorityScore,
        targetStatus,
      });

      if (result.length > 0) {
        break;
      }

      retryCount++;
      if (retryCount < MAX_CLAIM_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_BASE_MS * Math.pow(2, retryCount - 1)));
      }
    }

    if (result.length === 0) {
      return { error: false as const, data: null, retryAttempts: retryCount };
    }

    return { error: false as const, data: result[0], retryAttempts: retryCount };
  }
}
