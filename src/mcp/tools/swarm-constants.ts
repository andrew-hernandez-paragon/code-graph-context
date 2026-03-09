/**
 * Shared constants for swarm coordination tools
 */

/**
 * Pheromone types and their half-lives in milliseconds.
 * Half-life determines decay rate - after one half-life, intensity drops to 50%.
 */
export const PHEROMONE_CONFIG = {
  exploring: { halfLife: 2 * 60 * 1000, description: 'Browsing/reading' },
  modifying: { halfLife: 10 * 60 * 1000, description: 'Active work' },
  claiming: { halfLife: 60 * 60 * 1000, description: 'Ownership' },
  completed: { halfLife: 24 * 60 * 60 * 1000, description: 'Done' },
  warning: { halfLife: -1, description: 'Never decays' },
  blocked: { halfLife: 5 * 60 * 1000, description: 'Stuck' },
  proposal: { halfLife: 60 * 60 * 1000, description: 'Awaiting approval' },
  needs_review: { halfLife: 30 * 60 * 1000, description: 'Review requested' },
  session_context: { halfLife: 8 * 60 * 60 * 1000, description: 'Session working context marker' },
} as const;

/**
 * Task status values for the blackboard task queue
 */
export const TASK_STATUSES: readonly [string, ...string[]] = [
  'available', // Ready to be claimed by an agent
  'claimed', // An agent has claimed but not started
  'in_progress', // Agent is actively working
  'blocked', // Task is blocked by dependencies or issues
  'needs_review', // Work done, awaiting review
  'completed', // Successfully finished
  'failed', // Task failed
  'cancelled', // Task was cancelled
];

export type TaskStatus =
  | 'available'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'needs_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Task priority levels (higher = more urgent)
 */
export const TASK_PRIORITIES = {
  critical: 100, // Must be done immediately
  high: 75, // Important, do soon
  normal: 50, // Standard priority
  low: 25, // Can wait
  backlog: 0, // Do when nothing else is available
} as const;

export type TaskPriority = keyof typeof TASK_PRIORITIES;

/**
 * Task types for categorization
 */
export const TASK_TYPES: readonly [string, ...string[]] = [
  'implement', // Write new code
  'refactor', // Improve existing code
  'fix', // Bug fix
  'test', // Write/fix tests
  'review', // Code review
  'document', // Documentation
  'investigate', // Research/explore
  'plan', // Planning/design
];

export type TaskType = 'implement' | 'refactor' | 'fix' | 'test' | 'review' | 'document' | 'investigate' | 'plan';

/**
 * Generate a unique task ID
 */
export const generateTaskId = (): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `task_${timestamp}_${random}`;
};

export type PheromoneType = keyof typeof PHEROMONE_CONFIG;

export const PHEROMONE_TYPES = Object.keys(PHEROMONE_CONFIG) as PheromoneType[];

/**
 * Get half-life for a pheromone type.
 * Returns -1 for types that never decay (e.g., warning).
 */
export const getHalfLife = (type: PheromoneType): number => {
  return PHEROMONE_CONFIG[type]?.halfLife ?? PHEROMONE_CONFIG.exploring.halfLife;
};

/**
 * Workflow states are mutually exclusive per agent+node.
 * Setting one removes others in this group.
 * Flags (warning, proposal, needs_review) can coexist with workflow states.
 */
export const WORKFLOW_STATES: PheromoneType[] = ['exploring', 'claiming', 'modifying', 'completed', 'blocked'];

/**
 * Flags can coexist with workflow states.
 */
export const FLAG_TYPES: PheromoneType[] = ['warning', 'proposal', 'needs_review', 'session_context'];

// ============================================================================
// SWARM MESSAGING CONSTANTS
// ============================================================================

/**
 * Message categories for direct agent-to-agent communication.
 * Unlike pheromones (passive, decay-based), messages are explicit and persistent until read.
 */
export const MESSAGE_CATEGORIES = {
  blocked: 'Agent is blocked and needs help',
  conflict: 'File or resource conflict detected',
  finding: 'Important discovery another agent should know',
  request: 'Direct request to another agent',
  alert: 'Urgent notification (e.g., breaking change, test failure)',
  handoff: 'Context handoff between agents (e.g., partial work)',
} as const;

export type MessageCategory = keyof typeof MESSAGE_CATEGORIES;

export const MESSAGE_CATEGORY_KEYS = Object.keys(MESSAGE_CATEGORIES) as [MessageCategory, ...MessageCategory[]];

/**
 * Default TTL for messages (4 hours). Messages older than this are auto-cleaned.
 */
export const MESSAGE_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Generate a unique message ID
 */
export const generateMessageId = (): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `msg_${timestamp}_${random}`;
};

// ============================================================================
// ORCHESTRATOR CONSTANTS
// ============================================================================

/**
 * Generate a unique swarm ID for orchestrator runs
 */
export const generateSwarmId = (): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `swarm_${timestamp}_${random}`;
};

/**
 * Generate a unique agent ID for worker agents
 */
export const generateAgentId = (swarmId: string, index: number): string => {
  return `${swarmId}_agent_${index}`;
};

/**
 * Orchestrator configuration defaults
 */
export const ORCHESTRATOR_CONFIG = {
  /** Default maximum number of concurrent worker agents */
  defaultMaxAgents: 3,
  /** Maximum allowed agents (hard limit) */
  maxAgentsLimit: 10,
  /** Polling interval for monitoring progress (ms) */
  monitorIntervalMs: 1000,
  /** Timeout for waiting on worker agents (ms) - 30 minutes */
  workerTimeoutMs: 30 * 60 * 1000,
  /** Delay between spawning agents (ms) */
  spawnDelayMs: 500,
  /** Minimum nodes to consider for parallelization */
  minNodesForParallel: 3,
} as const;

/**
 * Task inference patterns for decomposing natural language tasks
 */
export const TASK_INFERENCE_PATTERNS = {
  rename: {
    keywords: ['rename', 'change name', 'refactor name'],
    taskType: 'refactor' as const,
    description: (oldName: string, newName: string) => `Rename "${oldName}" to "${newName}" and update all references`,
  },
  document: {
    keywords: ['jsdoc', 'document', 'add comments', 'add documentation'],
    taskType: 'document' as const,
    description: (target: string) => `Add documentation to ${target}`,
  },
  migrate: {
    keywords: ['migrate', 'convert', 'upgrade', 'modernize'],
    taskType: 'refactor' as const,
    description: (from: string, to: string) => `Migrate from ${from} to ${to}`,
  },
  deprecate: {
    keywords: ['deprecate', 'deprecation warning', 'mark deprecated'],
    taskType: 'refactor' as const,
    description: (target: string) => `Add deprecation warning to ${target}`,
  },
  fix: {
    keywords: ['fix', 'repair', 'correct', 'resolve'],
    taskType: 'fix' as const,
    description: (issue: string) => `Fix ${issue}`,
  },
  test: {
    keywords: ['test', 'add tests', 'write tests', 'unit test'],
    taskType: 'test' as const,
    description: (target: string) => `Write tests for ${target}`,
  },
} as const;

/**
 * Orchestrator status values
 */
export type OrchestratorStatus = 'planning' | 'spawning' | 'executing' | 'monitoring' | 'completed' | 'failed';

/**
 * Worker agent states
 */
export type WorkerState = 'idle' | 'claiming' | 'working' | 'completed' | 'failed' | 'timeout';

/**
 * Structure for atomic tasks created by decomposition
 */
export interface AtomicTask {
  title: string;
  description: string;
  type: TaskType;
  nodeIds: string[];
  filePath: string;
  dependencies: string[];
  metadata?: Record<string, unknown>;
}
