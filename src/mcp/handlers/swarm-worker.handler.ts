/**
 * Swarm Worker Handler
 * Defines the protocol for worker agents spawned by the orchestrator
 *
 * This handler provides:
 * 1. Worker agent initialization and lifecycle management
 * 2. Task claiming and execution protocol
 * 3. Pheromone coordination for conflict avoidance
 * 4. Progress reporting and error handling
 */

import { ORCHESTRATOR_CONFIG, WorkerState, generateAgentId } from '../tools/swarm-constants.js';

/**
 * Worker configuration
 */
export interface WorkerConfig {
  swarmId: string;
  projectId: string;
  agentIndex: number;
  maxRetries?: number;
  idleTimeoutMs?: number;
}

/**
 * Task execution result
 */
export interface TaskExecutionResult {
  success: boolean;
  summary?: string;
  filesChanged?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  error?: string;
  retryable?: boolean;
}

/**
 * Worker progress update
 */
export interface WorkerProgress {
  agentId: string;
  state: WorkerState;
  currentTaskId?: string;
  currentTaskTitle?: string;
  tasksCompleted: number;
  tasksFailed: number;
  lastActivityTime: number;
}

/**
 * SwarmWorkerHandler - Manages worker agent behavior
 *
 * Note: This handler generates prompts and protocols for worker agents.
 * The actual agent execution is done by Claude Code's Task tool.
 */
export class SwarmWorkerHandler {
  private workerProgress: Map<string, WorkerProgress> = new Map();

  /**
   * Generate the prompt/instructions for a worker agent
   * This is used when spawning agents via Claude Code's Task tool
   */
  generateWorkerPrompt(config: WorkerConfig): string {
    const agentId = generateAgentId(config.swarmId, config.agentIndex);

    return `You are a swarm worker agent (${agentId}) participating in swarm ${config.swarmId}.

## Your Role
You are part of a coordinated team of AI agents working together on a complex codebase task. Your job is to claim available tasks, execute them, and coordinate with other workers through pheromone markers.

## Project Context
- Project ID: ${config.projectId}
- Swarm ID: ${config.swarmId}
- Agent ID: ${agentId}

## Your Workflow

### 1. Check for Available Work
First, sense what other agents are doing:
\`\`\`
swarm_sense({
  projectId: "${config.projectId}",
  swarmId: "${config.swarmId}",
  types: ["modifying", "claiming"],
  excludeAgentId: "${agentId}"
})
\`\`\`

### 2. Claim a Task
Claim and start the highest-priority available task:
\`\`\`
swarm_claim_task({
  projectId: "${config.projectId}",
  swarmId: "${config.swarmId}",
  agentId: "${agentId}"
})
\`\`\`

If no task is returned, check if the swarm is complete:
\`\`\`
swarm_get_tasks({
  projectId: "${config.projectId}",
  swarmId: "${config.swarmId}",
  includeStats: true
})
\`\`\`

If stats show available=0 and inProgress=0, the swarm is complete. Exit gracefully.

### 3. Leave Pheromone Marker
Before starting work, mark the target node:
\`\`\`
swarm_pheromone({
  projectId: "${config.projectId}",
  nodeId: "<first target node from task>",
  type: "modifying",
  agentId: "${agentId}",
  swarmId: "${config.swarmId}"
})
\`\`\`

### 5. Execute the Task
Read the task description carefully and execute it:
- Use Read tool to understand the current code
- Use Edit tool to make changes
- Follow the task's acceptance criteria
- Keep changes focused and atomic

### 6. Mark Completion
On success:
\`\`\`
swarm_complete_task({
  projectId: "${config.projectId}",
  taskId: "<task id>",
  agentId: "${agentId}",
  action: "complete",
  summary: "<brief summary of what you did>",
  filesChanged: ["<list of files changed>"]
})
\`\`\`

Update pheromone to completed:
\`\`\`
swarm_pheromone({
  projectId: "${config.projectId}",
  nodeId: "<target node>",
  type: "completed",
  agentId: "${agentId}",
  swarmId: "${config.swarmId}",
  data: { summary: "<what you did>" }
})
\`\`\`

On failure:
\`\`\`
swarm_complete_task({
  projectId: "${config.projectId}",
  taskId: "<task id>",
  agentId: "${agentId}",
  action: "fail",
  reason: "<what went wrong>",
  retryable: true
})
\`\`\`

Leave a blocked pheromone (will decay, allowing retry):
\`\`\`
swarm_pheromone({
  projectId: "${config.projectId}",
  nodeId: "<target node>",
  type: "blocked",
  agentId: "${agentId}",
  swarmId: "${config.swarmId}",
  data: { error: "<error message>" }
})
\`\`\`

### 7. Loop
Return to step 1 and claim the next available task.
Continue until no tasks remain.

## Important Rules

1. **Always leave pheromones** - This prevents conflicts with other agents
2. **Check before claiming** - Use swarm_sense to avoid conflicts
3. **Keep changes atomic** - One logical change per task
4. **Report honestly** - If you can't complete a task, mark it as failed so others can try
5. **Don't modify code outside your task** - Stay focused on assigned work
6. **Exit when done** - When no tasks remain, complete gracefully

## Conflict Avoidance

If you see a "modifying" or "claiming" pheromone on a node:
- Skip that task and find another
- The pheromone will decay if the other agent fails

## Error Recovery

If you encounter an error:
1. Mark the task as failed with retryable=true
2. Leave a "blocked" pheromone (5 min decay)
3. Move on to the next task
4. Another agent (or you, later) can retry

Begin working now. Start by sensing the environment and claiming your first task.`;
  }

  /**
   * Initialize a worker's progress tracking
   */
  initializeWorker(config: WorkerConfig): WorkerProgress {
    const agentId = generateAgentId(config.swarmId, config.agentIndex);

    const progress: WorkerProgress = {
      agentId,
      state: 'idle',
      tasksCompleted: 0,
      tasksFailed: 0,
      lastActivityTime: Date.now(),
    };

    this.workerProgress.set(agentId, progress);
    return progress;
  }

  /**
   * Update worker progress
   */
  updateWorkerProgress(agentId: string, update: Partial<WorkerProgress>): WorkerProgress | null {
    const progress = this.workerProgress.get(agentId);
    if (!progress) return null;

    Object.assign(progress, update, { lastActivityTime: Date.now() });
    return progress;
  }

  /**
   * Get all worker progress for a swarm
   */
  getSwarmProgress(swarmId: string): WorkerProgress[] {
    const results: WorkerProgress[] = [];
    for (const [agentId, progress] of this.workerProgress) {
      if (agentId.startsWith(swarmId)) {
        results.push(progress);
      }
    }
    return results;
  }

  /**
   * Check if a worker has timed out
   */
  isWorkerTimedOut(agentId: string, timeoutMs: number = ORCHESTRATOR_CONFIG.workerTimeoutMs): boolean {
    const progress = this.workerProgress.get(agentId);
    if (!progress) return true;

    const elapsed = Date.now() - progress.lastActivityTime;
    return elapsed > timeoutMs;
  }

  /**
   * Clean up worker tracking for a swarm
   */
  cleanupSwarm(swarmId: string): void {
    for (const agentId of this.workerProgress.keys()) {
      if (agentId.startsWith(swarmId)) {
        this.workerProgress.delete(agentId);
      }
    }
  }

  /**
   * Get aggregate stats for all workers in a swarm
   */
  getSwarmStats(swarmId: string): {
    activeWorkers: number;
    idleWorkers: number;
    totalTasksCompleted: number;
    totalTasksFailed: number;
  } {
    const workers = this.getSwarmProgress(swarmId);

    return {
      activeWorkers: workers.filter((w) => w.state === 'working' || w.state === 'claiming').length,
      idleWorkers: workers.filter((w) => w.state === 'idle').length,
      totalTasksCompleted: workers.reduce((sum, w) => sum + w.tasksCompleted, 0),
      totalTasksFailed: workers.reduce((sum, w) => sum + w.tasksFailed, 0),
    };
  }
}

/**
 * Export singleton instance
 */
export const swarmWorkerHandler = new SwarmWorkerHandler();
