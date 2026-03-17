---
name: swarm
description: Coordinate multiple parallel subagents using stigmergic pheromone trails and/or explicit task queues in the code graph. Use when you need to parallelize work across multiple files or modules, run a swarm of agents, coordinate agents without direct messaging, or manage complex multi-step workflows. Triggers on "swarm", "parallel agents", "coordinate agents", "pheromone", "stigmergy", "task queue", "blackboard", "multi-agent".
---

# Swarm Coordination System

Execute complex, multi-file codebase changes with parallel AI agents that coordinate through the code graph.

## Two Coordination Mechanisms

| Mechanism | Pattern | Best For |
|-----------|---------|----------|
| **Pheromones** | Stigmergy (indirect) | Exploration, claiming territory, avoiding conflicts |
| **Task Queue** | Blackboard (explicit) | Defined work items, dependencies, progress tracking |

Use both together: tasks define WHAT to do, pheromones prevent WHO from colliding.

---

## Quick Start: Manual Orchestration

For multi-file tasks, decompose and post tasks manually:

```javascript
// 1. Create a swarm and post tasks
swarm_post_task({
  projectId: "<PROJECT>",
  swarmId: "swarm_<slug>",
  title: "Implement feature X",
  description: "...",
  type: "implement",
  createdBy: "orchestrator"
})

// 2. Spawn workers to claim and execute tasks
Task({
  subagent_type: "general-purpose",
  run_in_background: false,  // CRITICAL: must be false for MCP tools
  prompt: "Claim and execute task from swarm_<slug>..."
})
```

---

## Core Concepts

### Swarm ID
Every swarm needs a unique ID for coordination and cleanup:
```javascript
const swarmId = `swarm_${Date.now()}`
```

### Node IDs
**NEVER fabricate node IDs.** They must come from graph tool responses:
```javascript
// Get from search
const result = search_codebase({ projectId, query: "..." })
const nodeId = Object.keys(result.nodes)[0]

// Get from traversal
const result = traverse_from_node({ projectId, filePath: "..." })
const nodeId = result.startNodeId
```

Format: `proj_<12hex>:<NodeType>:<16hex>`

### Pheromone Types

| Type | Half-Life | Meaning |
|------|-----------|---------|
| `exploring` | 2 min | Reading/browsing |
| `claiming` | 1 hour | Reserved territory |
| `modifying` | 10 min | Actively editing |
| `completed` | 24 hours | Work finished |
| `blocked` | 5 min | Stuck/waiting |
| `warning` | Never | Do not touch |
| `proposal` | 1 hour | Awaiting approval |
| `needs_review` | 30 min | Review requested |

Workflow states (`exploring`, `claiming`, `modifying`, `completed`, `blocked`) are mutually exclusive per agent+node.

### Task States

```
available → claimed → in_progress → completed
                  ↘ blocked (waiting on dependencies)
                  ↘ failed → retry → available
                  ↘ needs_review → approve/reject
```

---

## Worker Agent Protocol

Include this in every worker agent prompt:

```
You are a swarm worker agent.
- Agent ID: {AGENT_ID}
- Swarm ID: {SWARM_ID}
- Project: {PROJECT_ID}

## CRITICAL RULES
1. NEVER fabricate node IDs - get them from graph tool responses
2. ALWAYS include swarmId in pheromone and task calls
3. Check for conflicts with swarm_sense BEFORE claiming
4. Use run_in_background: false when spawning (MCP tools require it)

## WORKFLOW

### Step 1: Claim a task
swarm_claim_task({
  projectId: "{PROJECT_ID}",
  swarmId: "{SWARM_ID}",
  agentId: "{AGENT_ID}"
})
// Returns highest-priority available task, or "no_tasks" if done
// startImmediately=true by default — task moves to in_progress immediately

### Step 2: Get the node ID for the file
traverse_from_node({
  projectId: "{PROJECT_ID}",
  filePath: "<FILE_FROM_TASK>"
})
// Use result.startNodeId

### Step 3: Check for conflicts
swarm_sense({
  projectId: "{PROJECT_ID}",
  nodeIds: ["<NODE_ID>"],
  types: ["claiming", "modifying"],
  excludeAgentId: "{AGENT_ID}"
})
// If pheromones returned → skip this file, release task, get another

### Step 4: Claim the node
swarm_pheromone({
  projectId: "{PROJECT_ID}",
  nodeId: "<NODE_ID>",
  type: "claiming",
  agentId: "{AGENT_ID}",
  swarmId: "{SWARM_ID}"
})

### Step 5: Start working
// Task already started (startImmediately=true is the default in swarm_claim_task)
// If you claimed with startImmediately=false, use:
// swarm_advance_task({ projectId: "{PROJECT_ID}", taskId: "<TASK_ID>", agentId: "{AGENT_ID}" })

swarm_pheromone({
  projectId: "{PROJECT_ID}",
  nodeId: "<NODE_ID>",
  type: "modifying",
  agentId: "{AGENT_ID}",
  swarmId: "{SWARM_ID}"
})

### Step 6: Do the work
- Read files with Read tool
- Edit files with Edit tool
- Run tests if needed

### Step 7: Complete
swarm_pheromone({
  projectId: "{PROJECT_ID}",
  nodeId: "<NODE_ID>",
  type: "completed",
  agentId: "{AGENT_ID}",
  swarmId: "{SWARM_ID}",
  data: { summary: "<WHAT_YOU_DID>" }
})

swarm_complete_task({
  projectId: "{PROJECT_ID}",
  taskId: "<TASK_ID>",
  agentId: "{AGENT_ID}",
  action: "complete",
  summary: "<WHAT_YOU_DID>",
  filesChanged: ["<FILES>"]
})

### Step 8: Loop
Return to Step 1. Exit when swarm_claim_task returns "no_tasks".
```

---

## Manual Multi-Phase Orchestration

For complex features requiring shared contracts, use a phased approach:

### Phase 0: Discovery + Contracts

**Discovery Agent** (read-only):
```javascript
Task({
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: `You are a Discovery Agent for swarm {SWARM_ID}.

  READ the codebase and report patterns. DO NOT modify files.

  Use the code graph:
  - search_codebase({ projectId: "{PROJECT_ID}", query: "..." })
  - traverse_from_node({ projectId: "{PROJECT_ID}", filePath: "..." })

  Report:
  1. Naming conventions (database columns, DTO properties)
  2. Import patterns
  3. API conventions (endpoint paths, response format)
  4. Relevant config files`
})
```

**Contract Agent** (run in parallel):
```javascript
Task({
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: `You are a Contract Agent for swarm {SWARM_ID}.

  Define EXACT contracts all agents must follow:
  1. API endpoint paths and methods
  2. Interface/DTO definitions with exact property names
  3. Data flow between services

  Output complete interface definitions. DO NOT write files.`
})
```

### Phase 1: Implementation

Include contracts in EVERY implementation agent:

```javascript
Task({
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: `You are an Implementation Agent for swarm {SWARM_ID}.

  ## MANDATORY CONTRACTS (follow exactly)
  ${CONTRACTS_FROM_PHASE_0}

  ## Your Task
  ${SPECIFIC_TASK}

  Follow the Worker Agent Protocol above.`
})
```

### Phase 2: Validation

```javascript
Task({
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: `You are a Validation Agent for swarm {SWARM_ID}.

  Check (DO NOT fix):
  1. npm run build passes
  2. Endpoints match contract paths
  3. DTOs use exact contract property names
  4. Services are registered, injected, AND called

  Report issues with exact file:line locations.`
})
```

### Phase 3: Remediation

```javascript
Task({
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: `You are a Fix Agent for swarm {SWARM_ID}.

  Fix ONLY these specific errors:
  ${ERRORS_FROM_PHASE_2}

  Make minimal changes. Do not refactor other code.`
})
```

---

## Orchestrator Responsibilities

**You (the main Claude session) are the orchestrator.** After spawning workers, you MUST:

### 1. Monitor Progress

Poll until all workers complete:
```javascript
swarm_get_tasks({
  projectId: "<PROJECT>",
  swarmId: "<SWARM_ID>",
  includeStats: true
})
```

Check the `progress` object:
```javascript
{
  progress: {
    completed: 8,
    inProgress: 2,
    available: 0,
    blocked: 0,
    failed: 2,
    percentComplete: 67,
    isComplete: false,  // true when all tasks done
    summary: "8/12 completed (67%)"
  }
}
```

### 2. Determine Completion

Swarm is complete when:
- `inProgress === 0` AND `available === 0` (no work left)
- OR all tasks are `completed` or `failed`

### 3. Handle Failed Tasks

If `failed > 0`, decide:
- **Retry**: Call `swarm_complete_task({ taskId, action: "retry" })` to make task available again
- **Spawn new worker**: Create another Task agent to handle retries
- **Abandon**: Accept the failures and proceed to cleanup

### 4. MANDATORY Cleanup

**After swarm completes, you MUST clean up ALL artifacts:**

```javascript
// Remove all pheromones for this swarm
swarm_cleanup({
  projectId: "<PROJECT>",
  swarmId: "<SWARM_ID>",
  keepTypes: []  // Remove everything, including warnings
})
```

**Why cleanup is critical:**
- Pheromones pollute the graph for future operations
- Old SwarmTask nodes clutter queries
- Failed/incomplete tasks block future swarms

### 5. Report Results

After cleanup, summarize:
- Tasks completed successfully
- Tasks that failed (and why)
- Files changed across all workers
- Any warnings or issues discovered

---

## Common Failure Modes

| Problem | Cause | Fix |
|---------|-------|-----|
| "Node may not exist" | Fabricated node ID | Get ID from graph tool response |
| Task stuck as blocked | Dependencies incomplete | Check `swarm_get_tasks({ taskId })` for blockers |
| Agent doesn't edit files | Agent described actions instead of calling tools | Add "Actually invoke the Edit tool" to prompt |
| Permission denied on edit | Used `run_in_background: true` | Must use `run_in_background: false` |
| Two agents edited same file | Didn't check with `swarm_sense` first | Add conflict check to protocol |
| Build passes but feature broken | Service written but not wired | Phase 2 should verify service is called, not just exists |
| API mismatch between agents | No shared contracts | Use Phase 0 to define exact interfaces |

---

## Tool Reference

### Task Queue
| Tool | Purpose |
|------|---------|
| `swarm_post_task` | Add task to queue |
| `swarm_claim_task` | Claim task (startImmediately=true by default) |
| `swarm_release_task` | Release or abandon a claimed task |
| `swarm_advance_task` | Start or force-start a claimed task |
| `swarm_complete_task` | Complete/fail/review task |
| `swarm_get_tasks` | Query tasks, get stats |

### Messaging
| Tool | Purpose |
|------|---------|
| `swarm_message` | Direct agent-to-agent messaging |

### Session
| Tool | Purpose |
|------|---------|
| `session_save` | Save bookmark or note |
| `session_recall` | Restore bookmark or search notes |
| `cleanup_session` | Remove expired notes and old bookmarks |

### Pheromones
| Tool | Purpose |
|------|---------|
| `swarm_pheromone` | Leave/update/remove marker |
| `swarm_sense` | Query markers, detect conflicts |
| `swarm_cleanup` | Bulk delete markers |

---

## Prerequisites

1. Project must be parsed:
   ```javascript
   parse_typescript_project({
     projectPath: "<PATH>",
     tsconfigPath: "<PATH>/tsconfig.json",
     async: true
   })
   // Poll check_parse_status({ jobId }) until complete
   ```

2. Verify with `list_projects()`
