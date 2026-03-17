/**
 * Shared Cypher queries for swarm task handlers.
 *
 * Queries that are used by multiple handlers live here.
 * Handler-specific queries stay in their handler files.
 */

/**
 * Get current task state — used by all handlers for diagnostic error messages.
 */
export const GET_TASK_STATE_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.abandonCount as abandonCount,
         t.previousClaimedBy as previousClaimedBy
`;

/**
 * Claim a specific task by ID.
 * Uses APOC locking for atomic claim under concurrency.
 * Shared by claim-by-id and claim-and-start-by-id flows.
 */
export const CLAIM_TASK_BY_ID_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['available', 'blocked']

  // Check if dependencies are complete
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WHERE dep.status <> 'completed'
  WITH t, count(dep) as incompleteDeps

  // Only claim if all dependencies are complete
  WHERE incompleteDeps = 0

  // Acquire exclusive lock to prevent race conditions
  CALL apoc.lock.nodes([t])

  // Double-check status after acquiring lock
  WITH t WHERE t.status IN ['available', 'blocked']

  // Atomic claim
  SET t.status = $targetStatus,
      t.claimedBy = $agentId,
      t.claimedAt = timestamp(),
      t.startedAt = CASE WHEN $targetStatus = 'in_progress' THEN timestamp() ELSE null END,
      t.updatedAt = timestamp()

  // Return task details with target info
  WITH t
  OPTIONAL MATCH (t)-[:TARGETS]->(target)
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
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.createdBy as createdBy,
         t.metadata as metadata,
         collect(DISTINCT {
           id: target.id,
           type: labels(target)[0],
           name: target.name,
           filePath: target.filePath
         }) as targets
`;

/**
 * Claim the highest priority available task matching criteria.
 * Uses APOC locking for atomic claim under concurrency.
 * Supports both 'claimed' and 'in_progress' target states.
 */
export const CLAIM_NEXT_TASK_QUERY = `
  // Find available or blocked tasks (blocked tasks may have deps completed now)
  MATCH (t:SwarmTask {projectId: $projectId, swarmId: $swarmId})
  WHERE t.status IN ['available', 'blocked']
    AND ($types IS NULL OR size($types) = 0 OR t.type IN $types)
    AND ($minPriority IS NULL OR t.priorityScore >= $minPriority)

  // Exclude tasks with incomplete dependencies
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WHERE dep.status <> 'completed'
  WITH t, count(dep) as incompleteDeps
  WHERE incompleteDeps = 0

  // Re-establish context for ordering (required by Cypher syntax)
  WITH t
  ORDER BY t.priorityScore DESC, t.createdAt ASC
  LIMIT 1

  // Acquire exclusive lock to prevent race conditions
  CALL apoc.lock.nodes([t])

  // Double-check status after acquiring lock (another worker may have claimed it)
  WITH t WHERE t.status IN ['available', 'blocked']

  // Atomic claim - supports both claim and claim_and_start via $targetStatus
  SET t.status = $targetStatus,
      t.claimedBy = $agentId,
      t.claimedAt = timestamp(),
      t.startedAt = CASE WHEN $targetStatus = 'in_progress' THEN timestamp() ELSE null END,
      t.updatedAt = timestamp()

  // Return task details with target info
  WITH t
  OPTIONAL MATCH (t)-[:TARGETS]->(target)
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
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.createdBy as createdBy,
         t.metadata as metadata,
         collect(DISTINCT {
           id: target.id,
           type: labels(target)[0],
           name: target.name,
           filePath: target.filePath
         }) as targets
`;
