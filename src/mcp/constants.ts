/**
 * MCP Server Constants
 * All constants used throughout the MCP server implementation
 */

import { readPackageVersion } from '../core/utils/package-version.js';

// Re-export shared constants
export { LOG_CONFIG } from '../constants.js';

// Server Configuration
export const MCP_SERVER_CONFIG = {
  name: 'code-graph-context',
  version: readPackageVersion(),
} as const;

// File Paths
export const FILE_PATHS = {
  debugLog: 'debug-search.log',
  schemaOutput: 'neo4j-apoc-schema.json',
  graphOutput: 'graph.json',
} as const;

// Tool Names
export const TOOL_NAMES = {
  hello: 'hello',
  searchCodebase: 'search_codebase',
  naturalLanguageToCypher: 'natural_language_to_cypher',
  traverseFromNode: 'traverse_from_node',
  parseTypescriptProject: 'parse_typescript_project',
  testNeo4jConnection: 'test_neo4j_connection',
  impactAnalysis: 'impact_analysis',
  checkParseStatus: 'check_parse_status',
  listProjects: 'list_projects',
  createProject: 'create_project',
  startWatchProject: 'start_watch_project',
  stopWatchProject: 'stop_watch_project',
  listWatchers: 'list_watchers',
  detectDeadCode: 'detect_dead_code',
  detectDuplicateCode: 'detect_duplicate_code',
  swarmPheromone: 'swarm_pheromone',
  swarmSense: 'swarm_sense',
  swarmCleanup: 'swarm_cleanup',
  swarmPostTask: 'swarm_post_task',
  swarmClaimTask: 'swarm_claim_task',
  swarmReleaseTask: 'swarm_release_task',
  swarmAdvanceTask: 'swarm_advance_task',
  swarmCompleteTask: 'swarm_complete_task',
  swarmGetTasks: 'swarm_get_tasks',
  cleanupSession: 'cleanup_session',
  swarmMessage: 'swarm_message',
  sessionSave: 'session_save',
  sessionRecall: 'session_recall',
  sessionUpdate: 'session_update',
  querySignals: 'query_signals',
  querySignalsOutcome: 'query_signals_outcome',
  ingestCursordiffSession: 'ingest_cursordiff_session',
  stopIngestCursordiffSession: 'stop_ingest_cursordiff_session',
  listIngestCursordiffWatchers: 'list_ingest_cursordiff_watchers',
  ingestDeliberateSession: 'ingest_deliberate_session',
  stopIngestDeliberateSession: 'stop_ingest_deliberate_session',
  listIngestDeliberateWatchers: 'list_ingest_deliberate_watchers',
} as const;

// Annotations: the store is local, so no tool reaches an open world. MCP defaults to destructive and open-world.
const LOCAL_STORE = { openWorldHint: false } as const;
const READS = { ...LOCAL_STORE, readOnlyHint: true } as const;
const ADDS = { ...LOCAL_STORE, readOnlyHint: false, destructiveHint: false } as const;
const ADDS_IDEMPOTENT = { ...ADDS, idempotentHint: true } as const;
const REPLACES = { ...LOCAL_STORE, readOnlyHint: false, destructiveHint: true } as const;
const REPLACES_IDEMPOTENT = { ...REPLACES, idempotentHint: true } as const;

/** Server instructions: the MCP client puts these in the system prompt of every session, so keep them short. */
export const SERVER_INSTRUCTIONS = `A code graph and a memory store for agents, in one local Neo4j.

Projects. Every tool takes projectId: an id, a name, or a path. A project is one of:
- codebase: a parsed TypeScript repository. Code tools and memory both work.
- directory: a local directory that is not parsed (Terraform, Python, docs). Memory only.
- collection: a named set of memories with no directory, such as "workflow". Memory only.
list_projects shows every project with its memory counts. create_project adds a directory or a collection; parse_typescript_project adds a codebase. A path inside a registered project resolves to that project, a git worktree to its main repository, and session_save on an unregistered git repository registers it as a directory.

Code (codebases only): search_codebase finds code and returns node ids. Pass an id to traverse_from_node (callers with INCOMING, dependencies with OUTGOING), or to impact_analysis before changing shared code.

Memory (any project):
1. Before working in an area, call session_recall with a query. projectIds recalls a repository and a collection together.
2. After a discovery, call session_save with topic, content and category. Anchor it with aboutNodeIds (from search_codebase) or aboutPaths (files).
3. When recall reports staleAboutNodeIds, missingAboutPaths or changedAboutPaths, check the code, then session_update the note, or session_save a replacement with supersedes: [oldId].
4. To resume later, session_save a bookmark (summary, taskContext, workingSetNodeIds or workingSetPaths), then session_recall with its sessionId.

query_signals answers "what do we know about X" across code, notes and pheromones in one call. The swarm_* tools coordinate several agents with tasks, pheromones and messages.`;

/** projectId descriptions, worded once so every tool reads the same. */
export const PROJECT_ID_DESCRIPTION = {
  any: 'Project id, name, or path. list_projects shows every project.',
  codebase: 'Project id, name, or path of a parsed codebase. list_projects shows every project and its kind.',
  codebaseIfOnlyOne:
    'Project id, name, or path of a parsed codebase. Optional when only one codebase exists; list_projects shows every project and its kind.',
} as const;

// Tool Metadata
export const TOOL_METADATA = {
  [TOOL_NAMES.hello]: {
    title: 'Hello Tool',
    description: 'Checks that the code-graph-context MCP server is running. Diagnostic only.',
    annotations: READS,
  },
  [TOOL_NAMES.searchCodebase]: {
    title: 'Search Codebase',
    description: `Finds code in a parsed codebase from a natural language query, by meaning and by keyword, then follows the best match's callers and dependencies. Start here for any code question: where something is defined, how a feature works, what uses a symbol.

Needs a codebase project (list_projects shows each project's kind). Returns normalized JSON with a nodes map and relationship chains, plus \`matches\`: every hit in rank order (rank 1 is the traversal's start node) with its id, name, filePath and scores (\`fusedScore\`, \`vectorScore\` as Neo4j reports it, \`vectorCosine\`, \`lexicalScore\`). Pass a match's id to traverse_from_node (callers with INCOMING, dependencies with OUTGOING), to impact_analysis before changing it, or as aboutNodeIds on session_save. Node ids come only from this tool and traverse_from_node. If output is too large: reduce maxDepth, set includeCode=false, or reduce snippetLength.`,
    annotations: READS,
  },
  [TOOL_NAMES.naturalLanguageToCypher]: {
    title: 'Natural Language to Cypher',
    description: `Answers aggregate and structural questions about a parsed codebase by generating a Cypher query from your question and running it: counts ('how many services exist'), lists, bulk property filters, complex relationship patterns. Use search_codebase to find code. Requires OPENAI_API_KEY.

The generated query runs in a read-only transaction, so it cannot change the graph.

**Node types:** SourceFile, Class, Function, Method, Interface, Property, Parameter, Import, Export, Enum, TypeAlias
**Key relationships:** CONTAINS, HAS_MEMBER, HAS_PARAMETER, IMPORTS, EXTENDS, IMPLEMENTS, CALLS, TYPED_AS
**NestJS:** Use semanticType property (e.g., semanticType='NestController'). Relationships: INJECTS, EXPOSES, MODULE_IMPORTS/PROVIDES/EXPORTS
**Tips:** Use concrete properties (filePath, name) not abstract concepts.`,
    annotations: READS,
  },
  [TOOL_NAMES.traverseFromNode]: {
    title: 'Traverse from Node',
    description: `Shows what calls a code node, what it calls and what it depends on, starting from a node id or a file path. Use it after search_codebase to look at a match other than the best one, or to follow one direction further: INCOMING for callers, OUTGOING for dependencies.

Takes nodeId (from search_codebase results) or filePath. Set summaryOnly=true for file paths and statistics only.`,
    annotations: READS,
  },
  [TOOL_NAMES.parseTypescriptProject]: {
    title: 'Parse TypeScript Project',
    description: `Parses a TypeScript or NestJS repository into the code graph and registers it as a codebase project, so search_codebase, traverse_from_node and impact_analysis work on it. Run once per repository; start_watch_project keeps the graph current afterwards.

A directory project already registered at projectPath becomes the codebase and keeps its memories. Set clearExisting=true to replace an existing graph. Use async=true (the default): it returns a jobId immediately; poll check_parse_status with it.`,
    annotations: REPLACES,
  },
  [TOOL_NAMES.testNeo4jConnection]: {
    title: 'Test Neo4j Connection & APOC',
    description:
      'Checks that Neo4j is reachable and the APOC plugin is installed. Diagnostic only; use it when other tools fail with connection errors.',
    annotations: READS,
  },
  [TOOL_NAMES.impactAnalysis]: {
    title: 'Impact Analysis',
    description: `Shows what depends on a code node or file, and how far a change would spread, before you modify shared code. Returns a risk level (LOW/MEDIUM/HIGH/CRITICAL), direct and transitive dependents, affected files and critical paths.

Takes nodeId (from search_codebase or traverse_from_node) or filePath, in a parsed codebase.`,
    annotations: READS,
  },
  [TOOL_NAMES.checkParseStatus]: {
    title: 'Check Parse Status',
    description: `Reports the status, progress and final result of a parse started by parse_typescript_project. Pass the jobId that call returned.`,
    annotations: READS,
  },
  [TOOL_NAMES.listProjects]: {
    title: 'List Projects',
    description: `Lists every project (codebase, directory or collection) with its id, name, kind, path, description, parse status and memory counts (live notes, bookmarks, last save). Use it to find the projectId other tools take, or to see where memories already live. Filter with kinds.`,
    annotations: READS,
  },
  [TOOL_NAMES.createProject]: {
    title: 'Create Project',
    description: `Creates a place to keep memories (notes and bookmarks) outside a parsed codebase. kind 'directory' registers an existing local directory that is not parsed, such as Terraform, Python or docs (pass path); kind 'collection' creates a named set of memories with no directory (pass name and description). Calling it again for the same directory or collection returns the existing project with created=false. Then pass its id to session_save and session_recall. Parse a TypeScript repository with parse_typescript_project instead.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.startWatchProject]: {
    title: 'Start Watch Project',
    description: `Keeps a codebase's graph current by re-parsing .ts files as they change. Needs a codebase parsed with parse_typescript_project. Excludes node_modules, dist, build and .git. Stop it with stop_watch_project; list_watchers shows active watchers.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.stopWatchProject]: {
    title: 'Stop Watch Project',
    description: `Stops watching a codebase for file changes. The graph stays as it was at the last update.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.listWatchers]: {
    title: 'List Watchers',
    description: `Lists active file watchers started with start_watch_project, with their status and pending changes.`,
    annotations: READS,
  },
  [TOOL_NAMES.detectDeadCode]: {
    title: 'Detect Dead Code',
    description: `Finds unused exports, uncalled methods and orphan interfaces in a parsed codebase. Returns items with confidence scores grouped by type and category.

Auto-excludes NestJS entry points. Use filterCategory=internal-unused for actionable cleanup.`,
    annotations: READS,
  },
  [TOOL_NAMES.detectDuplicateCode]: {
    title: 'Detect Duplicate Code',
    description: `Finds duplicated code in a parsed codebase by structure (AST hash) and by meaning (embeddings). Returns groups of duplicates with similarity scores.`,
    annotations: READS,
  },
  [TOOL_NAMES.swarmPheromone]: {
    title: 'Swarm Pheromone',
    description: `Marks a code node with a pheromone so other agents see what you are doing to it. Workflow states (exploring/claiming/modifying/completed/blocked) are mutually exclusive per agent+node. Flag types (warning/proposal/needs_review/session_context) can coexist. Pheromones decay automatically; swarm_sense reads them.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.swarmSense]: {
    title: 'Swarm Sense',
    description: `Shows which pheromones other agents have left on code nodes, to see what they are working on. Filter by swarmId, types, nodeIds, agentIds. Returns pheromones with current intensity after decay.`,
    annotations: READS,
  },
  [TOOL_NAMES.swarmCleanup]: {
    title: 'Swarm Cleanup',
    description: `Deletes pheromones, tasks and messages for a swarm or an agent in bulk. Warning pheromones are preserved by default. Use dryRun=true to preview.`,
    annotations: REPLACES_IDEMPOTENT,
  },
  [TOOL_NAMES.swarmPostTask]: {
    title: 'Swarm Post Task',
    description: `Adds a task to the swarm queue for another agent to claim with swarm_claim_task. Use the dependencies array for task ordering; tasks with incomplete dependencies block until ready.

Question primitive: post with type='question' to ask a synchronous question that another agent (typically the orchestrator or a domain-expert subagent) must answer before the asker proceeds. Asker polls swarm_get_tasks({ taskId }) every ~10s for up to 5 polls, then either reads the answer (status=completed; answer arrives via swarm_message with category='answer' linked to this taskId) or halts with BLOCKED.md. Set metadata.askerAgentId so the answerer knows where to direct the answer message.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.swarmClaimTask]: {
    title: 'Swarm Claim Task',
    description: `Claims a task from the swarm queue. Without taskId, claims the highest-priority available task. Set startImmediately=false to claim without starting.

Flow: swarm_claim_task → do work → swarm_complete_task. Use swarm_release_task to give up work, swarm_advance_task for state transitions. swarm_post_task adds tasks.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.swarmReleaseTask]: {
    title: 'Swarm Release Task',
    description: `Releases a task you claimed and can no longer complete, so another agent can claim it. Set trackAbandonment=true to record the abandonment for retry tracking.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.swarmAdvanceTask]: {
    title: 'Swarm Advance Task',
    description: `Starts a task you claimed. Use it after swarm_claim_task with startImmediately=false, or set force=true to recover from a stuck claimed state.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.swarmCompleteTask]: {
    title: 'Swarm Complete Task',
    description: `Marks a task you claimed as completed or failed, or requests review. Completing unblocks dependent tasks. Failed tasks can be retried if retryable=true.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.swarmGetTasks]: {
    title: 'Swarm Get Tasks',
    description: `Lists swarm tasks. Use taskId for a single task, or filter by swarmId, statuses, types, claimedBy. Add includeStats=true for aggregate counts.

Question polling: pass types=['question'] to find unanswered questions. Askers poll a specific question via taskId until status='completed', then read the linked answer message.`,
    annotations: READS,
  },
  [TOOL_NAMES.cleanupSession]: {
    title: 'Cleanup Session',
    description: `Deletes expired notes and old bookmarks (memory) in a project, keeping the most recent bookmarks per session. Use dryRun=true to preview what would be deleted.`,
    annotations: REPLACES_IDEMPOTENT,
  },
  [TOOL_NAMES.sessionSave]: {
    title: 'Session Save',
    description: `Remembers a discovery, decision or risk as a note, or saves your working state as a bookmark, in any project: codebase, directory or collection. The type is detected from the input. A note needs topic, content and category. A bookmark needs summary, taskContext and workingSetNodeIds or workingSetPaths; give both sets of fields to save a bookmark with a note.

Anchor a note to what it is about with aboutNodeIds (ids from search_codebase) or aboutPaths (files and folders); session_recall then reports when an anchor has gone or changed. To replace older notes, pass supersedes with their ids: the new note stays current and each old note is marked superseded by it. A path inside a git repository that is not registered registers that repository as a directory project. Retrieve with session_recall.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.sessionRecall]: {
    title: 'Session Recall',
    description: `Recalls saved notes and bookmarks (memory) from one or more projects. Pass query to search notes by meaning; pass sessionId to restore that session's latest bookmark and its notes. Call it before working in an area. projectIds recalls across several projects in one call, such as a repository and a collection.

Each note reports staleAboutNodeIds, missingAboutPaths and changedAboutPaths when its anchors no longer match the code. Check the code, then fix the note with session_update or replace it with session_save and supersedes. Superseded notes are hidden unless includeSuperseded=true.`,
    annotations: READS,
  },
  [TOOL_NAMES.sessionUpdate]: {
    title: 'Session Update',
    description: `Revises a saved note in place: fix a typo, change severity or category, correct content, replace its aboutNodeIds or aboutPaths, or mark it superseded. Every update refreshes the note's lastValidated time. For a substantive change or a reversed decision, use session_save with supersedes: [<oldId>] instead, which keeps the old note as history. Find note ids with session_recall.`,
    annotations: REPLACES_IDEMPOTENT,
  },
  [TOOL_NAMES.swarmMessage]: {
    title: 'Swarm Message',
    description: `Sends, reads and acknowledges direct messages between agents in a swarm. Unlike pheromones (passive, decay-based), messages are explicit and delivered when agents claim tasks. Use for critical coordination signals.

Actions: send (post or broadcast), read (retrieve), acknowledge (mark read).

Categories (coordination): blocked, conflict, finding, request, alert, handoff, answer.
Categories (consensus dialogue): position, agree, dissent. Generic multi-agent consensus primitives; any protocol that needs N agents to converge on a stance can use them (current primary consumer is the /deliberate skill).

Answer convention: when answering a type='question' task, send with category='answer', toAgentId=<askerAgentId from question metadata>, and taskId=<question taskId>. After sending, the answerer should call swarm_complete_task({ action: 'complete', taskId }) so the asker's poll sees status='completed' and reads the linked answer message.`,
    annotations: ADDS,
  },
  [TOOL_NAMES.querySignals]: {
    title: 'Query Signals',
    description: `Answers "what do we know about X?" in one call, with sectioned results from code, notes (memory) and pheromones for one or more projects. Replaces search_codebase + session_recall + swarm_sense when you want all three.

Returns per-source sections (code, notes, pheromones), each ranked by that source's native score. No cross-source fusion: you decide how to weight the sections.

Multi-project: pass projectIds (array) for cross-boundary search. groupBy:'project' pivots the response to project-keyed top-level.

Graceful degradation: if the embedding provider is unavailable, code section returns skipped:'embedding-provider-unavailable'; notes falls back to Cypher-only (no semantic ranking) with skipped:'semantic-ranking-unavailable'; pheromones section is always available.

Sources: code (vector search), notes (vector + Cypher), pheromones (intensity-ranked, query-independent).

Feedback loop: the response includes a queryId. If you cite one or more results in your next response, pass that queryId and the cited result IDs to query_signals_outcome to close the ranking-feedback loop.`,
    annotations: READS,
  },
  [TOOL_NAMES.querySignalsOutcome]: {
    title: 'Query Signals Outcome',
    description: `Records which results of a query_signals call you cited, so future ranking can improve. Call it after query_signals when you cite one or more results in your response.

Pass the queryId from the query_signals response and an array of cited results (resultId + source + sourceRank). Each citation is persisted as a QueryOutcome node and linked to the underlying cited node via a CITED edge.

Idempotent: calling with the same queryId + resultId twice does not double-record.

citationKind: 'direct' (quoted or closely paraphrased), 'paraphrase' (restated in own words), 'background' (influenced reasoning without explicit citation). Omit if unsure.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.ingestCursordiffSession]: {
    title: 'Ingest Cursordiff Session',
    description: `Ingests cursordiff JSONL files (router / lineage / decisions) into the graph.

mode="one-shot": read all rows currently on disk, run idempotent MERGEs, return a summary.
mode="watch":    start a live fs-watcher on the three files; new rows are ingested within ~500ms of write. Returns {watchId, paths, started} immediately. Use stop_ingest_cursordiff_session to stop.

dataDir defaults to ~/.local/share/nvim/cursordiff/.
dryRun=true plans but does not write to Neo4j (useful for smoke-testing fixtures).
tailOnly=true (watch mode only) skips existing rows and only ingests new writes.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.stopIngestCursordiffSession]: {
    title: 'Stop Ingest Cursordiff Session',
    description: `Stops a running cursordiff fs-watch session. Provide watchId (from ingest_cursordiff_session) or dataDir. Use list_ingest_cursordiff_watchers to see active sessions.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.listIngestCursordiffWatchers]: {
    title: 'List Ingest Cursordiff Watchers',
    description: `Lists all active cursordiff fs-watch sessions. Returns watchId, dataDir, rowsProcessed, lastActivityAt, lastErrorAt, lastError, and isProcessing for each watcher.`,
    annotations: READS,
  },
  [TOOL_NAMES.ingestDeliberateSession]: {
    title: 'Ingest Deliberate Session',
    description: `Ingests deliberation.jsonl (Deliberation / Position / Verdict events) into the graph.

mode="one-shot": read all rows currently on disk, run idempotent MERGEs, return a summary.
mode="watch":    start a live fs-watcher on deliberation.jsonl; new rows are ingested within ~500ms of write. Returns {watchId, paths, started} immediately. Use stop_ingest_deliberate_session to stop.

dataDir defaults to ~/.local/share/nvim/cursordiff/ (same dir as cursordiff JSONLs).
dryRun=true plans but does not write to Neo4j (useful for smoke-testing fixtures).
tailOnly=true (watch mode only) skips existing rows and only ingests new writes.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.stopIngestDeliberateSession]: {
    title: 'Stop Ingest Deliberate Session',
    description: `Stops a running deliberate fs-watch session. Provide watchId (from ingest_deliberate_session) or dataDir. Use list_ingest_deliberate_watchers to see active sessions.`,
    annotations: ADDS_IDEMPOTENT,
  },
  [TOOL_NAMES.listIngestDeliberateWatchers]: {
    title: 'List Ingest Deliberate Watchers',
    description: `Lists all active deliberation fs-watch sessions. Returns watchId, dataDir, rowsProcessed, lastActivityAt, lastErrorAt, lastError, and isProcessing for each watcher.`,
    annotations: READS,
  },
} as const;

// Default Values
export const DEFAULTS = {
  traversalDepth: 3,
  /** Floor for the vector channel of search_codebase, on Neo4j's (1 + cosine) / 2 score. */
  searchMinSimilarity: 0.5,
  skipOffset: 0,
  /** Batch size for node imports (larger payloads due to embeddings) */
  nodeBatchSize: 500,
  /** Batch size for edge imports (lightweight — just IDs and type) */
  edgeBatchSize: 2000,
  maxResultsDisplayed: 30,
  codeSnippetLength: 500, // Reduced from 1000 to control output size
  chainSnippetLength: 700,
  maxEmbeddingChars: 24000, // ~6000 tokens, safe margin for 8192 token limit on text-embedding-3-large
} as const;

// Parsing Configuration
export const PARSING = {
  /** File count threshold to trigger parallel parsing with worker pool */
  parallelThreshold: 250,
  /** File count threshold to trigger streaming import */
  streamingThreshold: 100,
  /** Default number of files per chunk */
  defaultChunkSize: 50,
  /** Worker timeout in milliseconds (default: 8 hours, configurable via WORKER_TIMEOUT_HOURS) */
  workerTimeoutMs: (Number(process.env.WORKER_TIMEOUT_HOURS) || 8) * 60 * 60 * 1000,
} as const;

// Job Management
export const JOBS = {
  /** Interval for cleaning up completed/stale jobs (5 minutes) */
  cleanupIntervalMs: 5 * 60 * 1000,
  /** Maximum number of jobs to keep in memory */
  maxJobs: 100,
} as const;

// Watch Mode Configuration
export const WATCH = {
  /** Default debounce delay before processing file changes */
  defaultDebounceMs: 1000,
  /** Maximum concurrent file watchers */
  maxWatchers: 10,
  /** Maximum pending file change events before dropping */
  maxPendingEvents: 1000,
  /** Default exclude patterns for file watching */
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/*.d.ts',
    '**/*.js',
    '**/*.map',
  ],
} as const;

// Messages
export const MESSAGES = {
  errors: {
    noRelevantCode: 'No relevant code found.',
    serviceNotInitialized:
      'natural_language_to_cypher requires OPENAI_API_KEY. Set it and restart the MCP server to enable this tool.',
    connectionTestFailed: 'Connection test failed',
    neo4jRequirement: 'Note: This server requires Neo4j with APOC plugin installed',
    genericError: 'ERROR:',
  },
  success: {
    hello: 'Hello from codebase MCP!',
    parseSuccess: 'SUCCESS:',
    partialSuccess: 'PARTIAL SUCCESS:',
  },
  queries: {
    naturalLanguagePrefix: 'Natural Language Query:',
    cypherQueryHeader: 'Generated Cypher Query',
    queryResultsHeader: 'Query Results',
    noResultsFound: 'No results found for this query.',
    moreResultsIndicator: '_... and {} more results_',
    summaryPrefix: '**Summary:** Executed query and found {} results.',
  },
  neo4j: {
    connectionTest: 'RETURN "Connected!" as message, datetime() as timestamp',
    apocTest: 'CALL apoc.help("apoc") YIELD name RETURN count(name) as apocFunctions',
    connectionSuccess: 'Neo4j connected: {} at {}\nAPOC plugin available with {} functions',
  },
  server: {
    starting: '=== MCP Server Starting ===',
    connected: '=== MCP Server Connected and Running ===',
    creatingTransport: 'Creating transport...',
    connectingTransport: 'Connecting server to transport...',
    startingServer: 'Starting MCP server...',
  },
} as const;

export const CONFIG_FILE_PATTERNS = {
  defaultGlobs: [
    'docker-compose*.{yml,yaml}',
    'Dockerfile*',
    '**/*.json', // All JSON files (package.json, tsconfig.json, .mcp.json, etc.)
    '**/*.{yml,yaml}', // All YAML files (CI configs, k8s manifests, etc.)
    '**/*.toml', // Cargo.toml, pyproject.toml, etc.
    '**/*.cfg', // Python setup.cfg, etc.
    '**/*.ini', // INI config files
    '**/Makefile', // Makefiles
    '.env*',
    '**/*.sh', // Shell scripts
    '**/*.py', // Python files (sidecar, scripts)
  ],
  excludeGlobs: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/coverage/**',
    '**/.next/**',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    // Local data, state, and volume directories
    '**/docker_volumes/**',
    '**/docker_data/**',
    '**/tmp/**',
    '**/.cache/**',
    '**/__snapshots__/**',
    '**/fixtures/**',
    '**/seeds/**',
  ],
  maxFileSizeBytes: 64 * 1024, // 64 KB — skip large config files (grafana dashboards, generated JSON, etc.)
};
