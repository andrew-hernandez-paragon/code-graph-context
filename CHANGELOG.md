# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - Graph as Persistent Memory - 2026-04-26

### Changed (BREAKING for tooling that relies on `CLEAR_PROJECT` nuking everything)

- `parse_typescript_project` with `clearExisting: true` (the default) no longer
  deletes `SessionNote`, `SessionBookmark`, `Pheromone`, or `Project` nodes for
  the target project. Code nodes (SourceFile, ClassDeclaration, etc.) are still
  rebuilt as before. The denylist is exposed as the `PRESERVED_LABELS` constant
  in `src/storage/neo4j/neo4j.service.ts`.
- After parse completes, `:ABOUT`, `:REFERENCES`, and `:MARKS` edges from
  preserved nodes to the (rebuilt) code nodes are automatically recreated using
  the deterministic node IDs persisted on each preserved node. Orphan references
  (IDs no longer present after reparse) are surfaced via the parse-success
  message and `session_recall`'s per-note `staleAboutNodeIds`.

### Added

- **`SessionNote.aboutNodeIds`, `lastValidated`, `supersededBy` properties**
  (auto-migrated on first MCP startup after upgrade). `aboutNodeIds` enables
  :ABOUT-edge recovery after reparse; `lastValidated` powers the recall
  freshness rerank; `supersededBy` is the single mechanism for "is this
  current?" — non-null filters the note out of default recall.
- **`session_recall` returns** `lastValidated`, `supersededBy`, `aboutNodeIds`,
  `staleAboutNodeIds` per note. Filters out superseded notes by default; pass
  `includeSuperseded: true` to surface history.
- **`SessionBookmark.embedding`** — bookmarks are now embedded on save and
  recallable via semantic search. New `session_bookmarks_idx` vector index;
  existing bookmarks backfilled paginated/idempotently on first MCP startup.
  `session_recall` with `query` and no `sessionId` now returns the top
  semantically-matched bookmark across all sessions, not just the current one.
- **`session_update`** — new tool for in-place revision of a SessionNote
  (typo, severity, lastValidated bump, minor content correction, `aboutNodeIds`
  resync, supersession marker). Re-embeds on content change; drops/recreates
  `:ABOUT` edges on `aboutNodeIds` change. For substantive changes prefer
  `session_save` with `supersededBy` set so history is preserved as a new note.
- **`CLEAR_PROJECT_FORCE`** — internal-only Cypher query (no denylist) for
  tests and explicit-nuke scenarios. Not exposed via the parse tool surface.

### Changed (UX)

- `session_recall` default `limit` 10 → 5. Pass `limit: 10` explicitly when
  broader retrieval is needed. Reduces conversation-context bloat.
- `session_recall` re-ranking: within similarity-sorted vector results,
  secondary order is `lastValidated DESC, severity DESC` so fresher and more
  critical notes surface first when scores are close. Filter-mode ordering
  switches to `coalesce(lastValidated, createdAt) DESC, createdAt DESC`.
- `session_recall`: query embedding is computed once per call and reused for
  both bookmark and note semantic searches (avoids the previous double-embed).

### Fixed

- Latent bug where the `Project` node's status update silently no-op'd because
  the node had been deleted by `CLEAR_PROJECT` between the upsert (status:
  'parsing') and the post-import update (status: 'complete'). Now Project
  metadata survives reparse and the status update lands as intended.

### Migration notes

- All schema additions are auto-migrated on first MCP startup after upgrade.
  The `migrateSessionNoteProperties` and `backfillBookmarkEmbeddings` functions
  in `src/mcp/service-init.ts` are idempotent — subsequent startups touch zero
  rows once data is migrated.
- No manual migration steps required. Failure of either migration is non-fatal
  and logged.

## [3.0.0] - MCP Tool Improvements - 2026-03-17

### Breaking Changes

- **Session tools consolidated (5→3):** `save_session_bookmark`, `restore_session_bookmark`, `save_session_note`, `recall_session_notes` replaced by `session_save` and `session_recall`. `cleanup_session` unchanged.
- **swarm_claim_task split into 3 tools:** Release/abandon actions moved to `swarm_release_task`. Start/force_start moved to `swarm_advance_task`. The `action` parameter replaced by `startImmediately` boolean.
- **traverse_from_node display params nested:** `includeCode`, `snippetLength`, `summaryOnly`, `maxNodesPerChain`, `maxTotalNodes`, `limit` moved into optional `displayOptions` object. Top-level params reduced from 13 to 8.

### Added

- **`session_save`**: Unified tool — auto-detects bookmark vs note based on input. Provide `workingSetNodeIds` for bookmark, `topic`+`content` for note, or both.
- **`session_recall`**: Unified tool — provide `sessionId` for bookmark restore, `query` for semantic note search, or both.
- **`swarm_release_task`**: Release or abandon a claimed task with optional abandonment tracking.
- **`swarm_advance_task`**: Start or force-start a claimed task.
- **`autoResolveProjectId`**: `detect_dead_code` and `detect_duplicate_code` now auto-resolve `projectId` when only one project exists. Parameter is optional.
- **`createEmptyResponse`** helper: Standardized `{ status: 'empty', message, suggestion }` shape for all "no results" responses.

### Changed

- **Tool descriptions restructured**: All 27+ tool descriptions now lead with category and usage hint (e.g., "Primary tool for...", "Swarm orchestration tool.", "Diagnostic tool.").
- **Parameter descriptions trimmed**: Removed restated defaults, types, enum values, and implementation details across all tool files. ~290 lines removed.
- **detect_dead_code / detect_duplicate_code**: Summary stats always included in response regardless of `summaryOnly` flag.
- **Error responses standardized**: Fixed `success: false` inside success response (session-bookmark) and plain-text empty results across 7 tool files.

### Fixed

- **`useWeightedTraversal` doc bug**: Description said default `false`, schema had `.default(true)`.
- **`chunkSize` doc bug**: Description said default `50`, schema had `.default(100)`.

## [2.3.0] - Swarm Coordination - 2025-01-XX

### Added

#### Swarm Coordination Tools

Multi-agent coordination through stigmergic pheromone markers in the code graph. Enables parallel agents to coordinate work without direct messaging.

- **`swarm_pheromone`**: Leave pheromone markers on code nodes
  - Pheromone types with exponential decay: `exploring` (2min), `modifying` (10min), `claiming` (1hr), `completed` (24hr), `warning` (never), `blocked` (5min), `proposal` (1hr), `needs_review` (30min)
  - Workflow states are mutually exclusive per agent+node (setting one removes others)
  - Flags (`warning`, `proposal`, `needs_review`) can coexist with workflow states
  - `swarmId` parameter for grouping related agents and enabling bulk cleanup
  - Creates `MARKS` relationship to target code nodes

- **`swarm_sense`**: Query pheromones in the code graph
  - Real-time intensity calculation with exponential decay
  - Filter by types, nodeIds, agentIds, swarmId
  - `excludeAgentId` to see what other agents are doing
  - Optional statistics by pheromone type
  - Cleanup of fully decayed pheromones (intensity < 0.01)
  - Self-healing nodeId matching (survives graph rebuilds)

- **`swarm_cleanup`**: Bulk delete pheromones after swarm completion
  - Delete by swarmId (clean up entire swarm)
  - Delete by agentId (clean up single agent)
  - Delete all in project (with caution)
  - `keepTypes` to preserve warnings by default
  - `dryRun` mode to preview deletions

#### Shared Constants

- **`swarm-constants.ts`**: Consolidated pheromone configuration
  - `PHEROMONE_CONFIG` with half-lives and descriptions
  - `PheromoneType` union type
  - `getHalfLife()` helper function
  - `WORKFLOW_STATES` and `FLAG_TYPES` arrays

### Changed

- **Debug Logging**: Added `debugLog` calls to MCP server components for better observability
  - Server initialization and stats
  - Watch manager notifications
  - Incremental parser operations
  - Tool call logging infrastructure

### Fixed

- **Neo4j OOM**: Optimized edge detection query to prevent out-of-memory errors on large codebases

---

## [2.2.0] - Parallel Parsing & TypeAlias Support - 2025-01-XX

### Added

#### Parallel Parsing with Worker Pool

- **Multi-Worker Architecture**: Parse large codebases using multiple CPU cores simultaneously
  - Configurable worker pool based on available CPUs (default: `Math.min(cpus - 1, 8)`)
  - Pull-based work distribution: workers signal ready, coordinator dispatches chunks
  - Streaming results: chunks are imported as they complete for pipelined processing
- **ChunkWorkerPool**: New infrastructure in `src/mcp/workers/chunk-worker-pool.ts`
  - Graceful shutdown with proper worker cleanup
  - Error propagation from worker threads
  - Progress tracking with `OnChunkComplete` callbacks
- **SerializedSharedContext**: Enables cross-worker shared state for edge resolution
  - Node exports, import sources, and class hierarchies serialized between workers
  - Deferred edges collected across chunks for final resolution

#### TypeAlias Parsing

- **TypeAlias Node Type**: Full support for TypeScript type aliases
  - Parses `type Foo = ...` declarations into graph nodes
  - Labels: `['TypeAlias', 'TypeScript']`
  - Captured properties: `name`, `isExported`
  - Embeddings skipped by default for type aliases

#### Nx Workspace Support

- **Nx Monorepo Detection**: Auto-detects Nx workspaces alongside existing support
  - Reads `nx.json` and `workspace.json` / `project.json` configurations
  - Discovers project targets and dependencies
  - Integrates with existing Turborepo, pnpm, Yarn, and npm workspace detection

#### Infrastructure Improvements

- **Graph Factory Utilities**: Consolidated node/edge creation in `src/core/utils/graph-factory.ts`
  - `generateDeterministicId()`: Stable node IDs across reparses
  - `createCoreEdge()`, `createCallsEdge()`: Factory functions for edge creation
  - `toNeo4jNode()`, `toNeo4jEdge()`: Conversion between parsed and Neo4j types
- **Centralized Constants**: Shared constants for file patterns, logging config in `src/constants.ts`
- **Consistent Debug Logging**: Migrated all `console.log` to `debugLog()` for configurable output

### Changed

- **NL-to-Cypher Prompts**: Now schema-driven rather than hardcoded
  - Dynamically loads valid labels from `rawSchema` in schema file
  - Improved error messages with AST-to-label mapping hints
  - Framework relationships discovered from schema at runtime
- **Edge Resolution**: Delegated from WorkspaceParser to TypeScriptParser
  - Enables per-chunk edge resolution in parallel parsing
  - Better separation of concerns between parsers
- **Streaming Import Handler**: Fixed duplicate detection in cross-chunk scenarios

### Fixed

- Worker thread graceful shutdown preventing orphaned processes
- Cross-chunk INTERNAL_API_CALL edge detection in streaming mode
- Streaming duplicates from incorrect chunk boundary handling

---

## [2.1.0] - Dead Code & Duplicate Detection - 2025-01-XX

### Added

#### New MCP Tools

- **`detect_dead_code`**: Identifies potentially dead code including:

  - Unreferenced exports (exported but never imported)
  - Uncalled private methods (no internal callers)
  - Unreferenced interfaces (never implemented/extended/typed)
  - Confidence scoring (HIGH/MEDIUM/LOW) with explanations
  - Risk level assessment (LOW/MEDIUM/HIGH/CRITICAL)
  - Framework-aware exclusions (NestJS controllers, modules, guards, pipes, interceptors, filters, providers, services)
  - Customizable exclusion patterns and semantic types
  - Pagination with limit/offset

- **`detect_duplicate_code`**: Identifies duplicate code using:
  - Structural duplicates (identical normalized AST hash)
  - Semantic duplicates (similar embeddings via vector search)
  - Configurable scope (methods, functions, classes, all)
  - Similarity thresholds and confidence scoring
  - Category detection (UI component, cross-app, same-file, cross-file)
  - Refactoring recommendations

#### Parser Enhancements

- **Code Normalization**: Generates `normalizedHash` for all code nodes
  - Removes comments and whitespace
  - Replaces string/numeric literals with placeholders
  - Replaces variable names with sequential placeholders
  - SHA256 hash for structural comparison
- **Parent Class Tracking**: Adds `parentClassName` property for methods/properties/constructors
- **CALLS Edge Support**: Parser now generates CALLS edges for method/function invocations

#### New Neo4j Queries

- `FIND_UNREFERENCED_EXPORTS` - Exports with no imports/references
- `FIND_UNCALLED_PRIVATE_METHODS` - Private methods with no CALLS edges
- `FIND_UNREFERENCED_INTERFACES` - Interfaces never used
- `GET_FRAMEWORK_ENTRY_POINTS` - Framework entry points for exclusion
- `FIND_STRUCTURAL_DUPLICATES` - Nodes with identical normalizedHash
- `FIND_SEMANTIC_DUPLICATES` - Nodes with similar embeddings

#### Infrastructure

- **normalizedHash Index**: New Neo4j index for efficient structural duplicate detection
- **Shared Utilities**: Common interfaces and helpers in `src/core/utils/shared-utils.ts`
- **Code Normalizer**: AST-based normalization in `src/core/utils/code-normalizer.ts`

### Changed

- CALLS edge schema now includes CONSTRUCTOR_DECLARATION in source/target types
- Improved cross-platform path handling in shared utilities (Windows/Unix compatibility)

---

## [2.0.0] - Multi-Project Support - 2024-12-30

### Added

#### Multi-Project Isolation

- **Project ID System**: All nodes now include a `projectId` prefix (`proj_<12-hex-chars>`) enabling complete data isolation between projects in a single Neo4j database
- **Deterministic ID Generation**: Same project path always generates the same projectId, ensuring reproducibility across reparses
- **Flexible Project Resolution**: All query tools accept project ID, project name, or project path - resolved automatically via `resolveProjectIdFromInput()`

#### New MCP Tools

- **`list_projects`**: List all parsed projects in the database with status, node/edge counts, and timestamps
- **`check_parse_status`**: Monitor async parsing jobs with real-time progress (phase, files processed, chunks, nodes/edges created)
- **`start_watch_project`**: Start file watching for a parsed project with configurable debounce
- **`stop_watch_project`**: Stop file watching for a project by ID
- **`list_watchers`**: List all active file watchers with status, pending changes, and last update time

#### File Watching & Live Updates

- **Real-Time File Monitoring**: Uses `@parcel/watcher` for cross-platform native file watching
- **Watch Mode in parse_typescript_project**: New `watch: true` parameter starts watching after synchronous parse (requires `async: false`)
- **Automatic Incremental Updates**: File changes trigger re-parsing of only affected files
- **Debounced Processing**: Configurable debounce delay (`watchDebounceMs`, default 1000ms) batches rapid file changes
- **Cross-File Edge Preservation**: Edges between changed and unchanged files are preserved during incremental updates
- **Graceful Shutdown**: SIGINT/SIGTERM handlers ensure watchers are properly cleaned up
- **Resource Limits**: Maximum 10 concurrent watchers, 1000 pending events per watcher

#### Async & Streaming Parsing

- **Async Parsing Mode**: New `async: true` parameter runs parsing in Worker threads without blocking the MCP server. Returns job ID for status monitoring
- **Streaming Import**: Large projects (>100 files) automatically use chunked processing to prevent OOM errors. Configurable via `useStreaming` and `chunkSize` parameters
- **Worker Thread Isolation**: Background parsing with 8GB heap limit and 30-minute timeout protection
- **Progress Reporting**: Real-time progress updates through all phases: discovery → parsing → importing → resolving → complete

#### Workspace & Monorepo Support

- **Auto-Detection**: Automatically detects workspace type (Turborepo, pnpm, Yarn workspaces, npm workspaces, or single project)
- **WorkspaceParser**: New parser that handles monorepo structures, discovering and parsing all packages
- **Package Discovery**: Reads workspace configuration from `turbo.json`, `pnpm-workspace.yaml`, or `package.json` workspaces field

#### Incremental Parsing

- **Change Detection**: Detects file changes using mtime, size, and content hash comparison
- **Selective Reparse**: Only reparses files that have actually changed when `clearExisting: false`
- **Cross-File Edge Preservation**: Saves and recreates edges between changed and unchanged files

#### Impact Analysis Enhancements

- **File-Based Analysis**: Analyze impact of entire files, not just individual nodes
- **Risk Scoring System**: Four-factor scoring (dependent count, relationship weights, high-risk types, transitive impact) producing LOW/MEDIUM/HIGH/CRITICAL risk levels
- **Relationship Weights**: Configurable weights for different relationship types (EXTENDS: 0.95, CALLS: 0.75, IMPORTS: 0.5, etc.)
- **Framework Configuration**: Custom `frameworkConfig` parameter for framework-specific risk assessment

#### New Utility Modules

- **`src/core/utils/project-id.ts`**: Project ID generation, validation, and resolution utilities
- **`src/core/utils/retry.ts`**: Generic retry wrapper with exponential backoff and jitter
- **`src/core/utils/progress-reporter.ts`**: Structured progress tracking through parsing phases
- **`src/core/utils/path-utils.ts`**: Path normalization, relative path conversion, common root detection
- **`src/core/config/timeouts.ts`**: Centralized timeout configuration with environment variable overrides

#### Infrastructure

- **Project Node Tracking**: Creates `Project` nodes in Neo4j tracking status (parsing/complete/failed), node counts, edge counts, and timestamps
- **Job Manager**: In-memory job tracking with automatic cleanup (1 hour TTL, 100 job max limit)
- **Cross-Chunk Edge Resolution**: Handles edges that span multiple parse chunks in streaming mode

### Changed

#### Tool Parameter Changes

- **`search_codebase`**: Now requires `projectId` parameter; added `useWeightedTraversal` (default: true) and improved similarity scoring
- **`traverse_from_node`**: Now requires `projectId` parameter; added `filePath` as alternative to `nodeId` for file-based traversal
- **`impact_analysis`**: Now requires `projectId` parameter; added `frameworkConfig` for custom relationship weights and high-risk type configuration
- **`natural_language_to_cypher`**: Now requires `projectId` parameter; added security validations and framework detection

#### Parser Improvements

- **Lazy Loading Mode**: New `lazyLoad` constructor option enables just-in-time file loading for large projects
- **Streaming Interface**: New `StreamingParser` interface with `discoverSourceFiles()`, `parseChunk()`, `resolveDeferredEdgesManually()` methods
- **Existing Nodes Support**: Parser can now load existing nodes from Neo4j for accurate edge target matching during incremental parsing

#### Neo4j Service

- Added 15+ new Cypher queries for:
  - Project management (`CLEAR_PROJECT`, `UPSERT_PROJECT_QUERY`, `UPDATE_PROJECT_STATUS_QUERY`)
  - Incremental parsing (`GET_CROSS_FILE_EDGES`, `DELETE_SOURCE_FILE_SUBGRAPHS`, `RECREATE_CROSS_FILE_EDGES`)
  - Discovery (`DISCOVER_NODE_TYPES`, `DISCOVER_RELATIONSHIP_TYPES`, `DISCOVER_SEMANTIC_TYPES`, `DISCOVER_COMMON_PATTERNS`)
  - Impact analysis (`GET_NODE_IMPACT`, `GET_FILE_IMPACT`, `GET_TRANSITIVE_DEPENDENTS`)
  - Weighted traversal with scoring (edge weight × node similarity × depth penalty)

#### Natural Language to Cypher

- Enhanced prompt instructions with multi-project isolation requirements
- Auto-detects framework type based on graph composition
- Schema context injection for better query generation
- Improved handling of class/service names vs labels

### Security

- **Path Traversal Protection**: Symlink resolution and project boundary validation prevents escaping project directory
- **Cypher Injection Prevention**: Relationship type validation using regex pattern `/^[A-Z_]+$/`
- **ReDoS Protection**: Regex character escaping in decorator parsing
- **Worker Thread Timeout**: 30-minute timeout prevents indefinitely hanging workers
- **Job Manager Limits**: Maximum 100 concurrent jobs prevents memory exhaustion
- **Session Closure Fix**: Neo4j session close wrapped in try-catch to preserve original errors
- **Log Sanitization**: Sensitive data (prompts, API errors) no longer logged in full
- **Input Validation**: Path existence validation before processing in parse tool
- **Neo4j Connection Cleanup**: All tools now properly close Neo4j connections in finally blocks

### Breaking Changes

#### projectId Required

All query tools now require a `projectId` parameter:

```typescript
search_codebase({ projectId, query, ... })
traverse_from_node({ projectId, nodeId, ... })
impact_analysis({ projectId, nodeId, ... })
natural_language_to_cypher({ projectId, prompt })
```

#### Node ID Format Change

Node IDs now include project prefix:

- **Old format**: `CoreType:hash` (e.g., `ClassDeclaration:abc123`)
- **New format**: `proj_xxx:CoreType:hash` (e.g., `proj_a1b2c3d4e5f6:ClassDeclaration:abc123`)

#### Database Incompatibility

Existing graphs created with previous versions are **not compatible** with this release:

- Old node IDs won't match new query patterns
- Queries will fail to find nodes without projectId filter

### Migration Guide

1. **Clear and Re-parse**: Clear your Neo4j database and re-parse all projects

   ```bash
   # Projects will auto-generate projectId from path
   ```

2. **Update Tool Calls**: Add `projectId` to all query tool invocations

   ```typescript
   // Before
   search_codebase({ query: 'UserService' });

   // After
   search_codebase({ projectId: 'my-project', query: 'UserService' });
   ```

3. **Discover Projects**: Use `list_projects` to see available projects and their IDs

   ```
   list_projects()
   → Shows: name, projectId, path, status, node/edge counts
   ```

4. **Use Friendly Names**: You can use project names instead of full IDs
   ```typescript
   // These are equivalent:
   search_codebase({ projectId: 'proj_a1b2c3d4e5f6', query: '...' });
   search_codebase({ projectId: 'my-backend', query: '...' });
   search_codebase({ projectId: '/path/to/my-backend', query: '...' });
   ```

---

## [1.1.0] - 2024-12-15

### Added

- `impact_analysis` tool for dependency risk assessment
- Graph efficiency improvements

---

## [0.1.0] - 2025-01-13

### Added

- Initial release of Code Graph Context MCP server
- TypeScript codebase parsing with AST analysis
- Neo4j graph storage with vector indexing
- Semantic search using OpenAI embeddings
- 6 MCP tools for code exploration:
  - `hello` - Test connection
  - `test_neo4j_connection` - Verify Neo4j connectivity
  - `parse_typescript_project` - Parse codebases into graph
  - `search_codebase` - Vector-based semantic search
  - `traverse_from_node` - Graph relationship traversal
  - `natural_language_to_cypher` - AI-powered Cypher query generation
- Framework-aware parsing with customizable patterns
- Custom framework schema system (with FairSquare example)
- Auto-detection of project framework types
- Docker Compose setup for Neo4j with APOC plugin
- Comprehensive README with examples and workflows

### Framework Support

- Decorator-based frameworks (Controllers, Services, Modules, Guards, Pipes, Interceptors, DTOs, Entities)
- Custom framework schema system (see FairSquare example)
- Vanilla TypeScript projects

### Infrastructure

- MIT License
- Contributing guidelines
- Example projects and custom framework templates
- Environment configuration via `.env`
- Debug logging for troubleshooting

---

[2.3.0]: https://github.com/andrew-hernandez-paragon/code-graph-context/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/andrew-hernandez-paragon/code-graph-context/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/andrew-hernandez-paragon/code-graph-context/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/andrew-hernandez-paragon/code-graph-context/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/andrew-hernandez-paragon/code-graph-context/compare/v0.1.0...v1.1.0
[0.1.0]: https://github.com/andrew-hernandez-paragon/code-graph-context/releases/tag/v0.1.0
