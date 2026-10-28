# Agent Guide — Code Graph Context

Guidance for AI coding agents (Claude Code, Cursor, Codex, Aider, etc.) working in this repository.

## Project Overview

Code Graph Context is an MCP (Model Context Protocol) server that builds code graphs to provide rich context to LLMs. It parses TypeScript codebases using AST analysis (ts-morph), stores the graph in Neo4j with vector embeddings, and provides semantic search and graph traversal tools.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode compilation
npm run mcp            # Run MCP server: node dist/mcp/mcp.server.js
npm run lint           # ESLint with auto-fix
npm run format         # Prettier formatting
```

## Architecture

### Data Flow
```
TypeScript Project → AST Parser (ts-morph) → Graph Nodes/Edges → Neo4j + Vector Embeddings → MCP Tools
```

### Key Directories

- `src/mcp/` - MCP server entry point and tools
  - `mcp.server.ts` - Server initialization
  - `tools/` - 7 MCP tools (search_codebase, traverse_from_node, impact_analysis, etc.)
  - `handlers/` - Business logic for graph generation and traversal
- `src/core/` - Core business logic
  - `parsers/typescript-parser.ts` - Main AST parser (~1000 lines)
  - `config/schema.ts` - Core graph schema definitions
  - `config/nestjs-framework-schema.ts` - NestJS semantic patterns
  - `embeddings/` - OpenAI embeddings and NL-to-Cypher services
- `src/storage/neo4j/` - Neo4j driver and queries

### Dual-Schema System

The parser uses two schema layers:
1. **Core Schema** (AST-level): ClassDeclaration, MethodDeclaration, PropertyDeclaration, ImportDeclaration, etc.
2. **Framework Schema** (Semantic): Controller, Service, Module, Guard, Repository, etc. (NestJS patterns)

Nodes have both `coreType` (AST) and `semanticType` (framework interpretation).

### Projects and Memory

One Neo4j holds many projects. Every tool takes `projectId`: an id (`proj_<12-hex-chars>`), a name, or a path. A path inside a registered project resolves to that project, and a git worktree to its main repository. A project has one of three kinds:

| Kind | What it is | Works with |
|------|-----------|------------|
| `codebase` | A parsed TypeScript repository | Code tools and memory |
| `directory` | A local directory that is not parsed (Terraform, Python, docs) | Memory only |
| `collection` | A named set of memories with no directory, such as `workflow` | Memory only |

- `list_projects` shows every project with its kind and memory counts; `kinds` filters.
- `parse_typescript_project` adds a codebase. The id is the explicit `projectId`, else the project already registered at `projectPath`, else a hash of the path. A directory project at that path becomes the codebase and keeps its memories.
- `create_project` adds a directory (`path`) or a collection (`name`, `description`). Calling it again returns the existing project with `created=false`.
- `session_save` on a path inside an unregistered git repository registers that repository as a directory.
- Code tools (`search_codebase`, `traverse_from_node`, `impact_analysis`, `natural_language_to_cypher`, `start_watch_project`) need a codebase and say so when given another kind.
- Memory tools work on any kind. `session_recall` takes `projectIds` (up to 10) to recall across projects in one call.
- Anchor a note with `aboutNodeIds` (code node ids from `search_codebase`) or `aboutPaths` (files and folders); bookmarks use `workingSetNodeIds` or `workingSetPaths`. Recall reports `staleAboutNodeIds`, `missingAboutPaths` and `changedAboutPaths`. Replace a note with `session_save` and `supersedes: [oldId]`.
- Queries are scoped to the project: nodes from different projects never interfere.

```typescript
search_codebase({ projectId: "proj_abc123...", query: "..." })
traverse_from_node({ projectId: "proj_abc123...", nodeId: "..." })
session_recall({ projectIds: ["backend", "workflow"], query: "token refresh" })
create_project({ kind: "collection", name: "workflow", description: "How we work" })
```

### Migration from Pre-Multi-Project Versions

If upgrading from a version without multi-project support, note these breaking changes:

**Breaking Changes:**
- Node IDs now include projectId prefix (format: `proj_xxx:CoreType:hash`)
- All query tools now require `projectId` parameter
- Existing nodes in the database have old ID format and won't be accessible

**Migration Options:**

1. **Clear and Re-parse (Recommended)**
   ```bash
   # Clear the database and re-parse your project
   # The new projectId will be auto-generated from the project path
   ```

2. **Continue Without Multi-Project**
   - Not recommended - existing node IDs are incompatible
   - Queries will fail to find nodes with old ID format

**Note:** There is no automatic migration path. Existing graphs must be rebuilt to use the new ID format with projectId isolation.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `search_codebase` | Primary tool — semantic search via vector embeddings |
| `traverse_from_node` | Follow-up exploration from a node ID |
| `impact_analysis` | Risk assessment — analyze dependencies before changes |
| `parse_typescript_project` | Build the graph from source code |
| `check_parse_status` | Poll async parsing job status |
| `natural_language_to_cypher` | Advanced — convert NL to Cypher queries (requires OpenAI) |
| `detect_dead_code` | Find unused exports, uncalled methods |
| `detect_duplicate_code` | Find structural and semantic duplicates |
| `list_projects` | List every project with its kind and memory counts |
| `create_project` | Register a directory or a named collection that holds memories |
| `test_neo4j_connection` | Diagnostic — verify Neo4j connectivity |
| `swarm_claim_task` | Claim a task from the queue |
| `swarm_release_task` | Release or abandon a claimed task |
| `swarm_advance_task` | Start or force-start a claimed task |
| `swarm_complete_task` | Mark task completed/failed |
| `swarm_post_task` | Post task to queue |
| `swarm_get_tasks` | Query tasks with filters |
| `swarm_pheromone` | Mark code nodes for coordination |
| `swarm_sense` | Query active pheromones |
| `swarm_cleanup` | Bulk delete pheromones/tasks |
| `swarm_message` | Direct agent-to-agent messaging |
| `session_save` | Save a note or bookmark in any project (unified) |
| `session_recall` | Recall notes and bookmarks from one or more projects (unified) |
| `session_update` | Revise a saved note in place, or move it to another project with `moveToProjectId` |
| `query_signals` | One call across code, notes and pheromones |
| `query_signals_outcome` | Record which query_signals results you cited |
| `cleanup_session` | Remove expired session data |
| `start_watch_project` | Watch for file changes |
| `stop_watch_project` | Stop watching |
| `list_watchers` | List active watchers |
| `hello` | Diagnostic — verify MCP server running |

### Response Format

All tools return JSON:API normalized responses:
- `nodes` map: Each node stored once, referenced by ID
- `depths` array: Relationship chains at each depth level
- Source code truncated to 1000 chars (first 500 + last 500)

### Response Size Control (Compact Mode)

All query tools support parameters to reduce response size for exploration:

| Parameter | Tools | Effect |
|-----------|-------|--------|
| `includeCode: false` | search_codebase, traverse_from_node | Exclude source code (names/paths only) |
| `summaryOnly: true` | traverse_from_node | Return only file paths and statistics |
| `snippetLength: N` | search_codebase, traverse_from_node | Limit code snippets to N characters |
| `maxTotalNodes: N` | traverse_from_node | Cap total unique nodes returned |
| `maxNodesPerChain: N` | both | Limit relationship chains per depth |
| `displayOptions` | traverse_from_node | Nested object — accepts `summaryOnly`, `snippetLength`, `includeCode`, `maxNodesPerChain` |

**Recommended usage patterns:**
```typescript
// Structure overview - just names/paths, no source code
search_codebase({ projectId: "...", query: "...", includeCode: false })

// Quick summary - file paths and statistics only
traverse_from_node({ projectId: "...", nodeId: "...", displayOptions: { summaryOnly: true } })

// Detailed with smaller snippets
traverse_from_node({ projectId: "...", nodeId: "...", displayOptions: { snippetLength: 200 } })

// Minimal output for large graphs
traverse_from_node({ projectId: "...", nodeId: "...", displayOptions: { includeCode: false, maxNodesPerChain: 3 } })
```

## Dependencies

- **Neo4j 2026.02+** with APOC plugin required (project-filtered vector search; the server logs an error at start and skips the vector index rebuild on older versions)
- **Python 3.10+** for local embeddings (sidecar)
- **ts-morph** for TypeScript AST parsing
- **OpenAI API** (optional) for embeddings and NL queries

## Embedding Configuration

Local BGE-base embeddings are the default. No API key is needed. The sidecar runs a Python
model that starts automatically on first use.

The sidecar virtualenv lives at `$CGC_DATA_DIR/sidecar-venv` (default `~/.local/share/code-graph-context/sidecar-venv`), not in the package, so `npm i -g` keeps it. Python is chosen in this order: `PYTHON_EXECUTABLE`, that venv, a legacy `sidecar/.venv` in the package, system python. `init` moves a legacy venv to the new path with a rename and builds a fresh one when the rename fails.

| Env Variable | Default | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `BAAI/bge-base-en-v1.5` | HuggingFace model for local embeddings |
| `EMBEDDING_DEVICE` | `mps`/`cpu` | Device for embeddings. Auto-detects MPS on Apple Silicon |
| `EMBEDDING_HALF_PRECISION` | `false` | Set `true` for float16 (halves memory) |
| `EMBEDDING_BATCH_SIZE` | `8` | Texts per embedding batch (lower = less memory, higher = faster) |
| `EMBEDDING_SIDECAR_PORT` | `8787` | Port for the local embedding server |
| `OPENAI_EMBEDDINGS_ENABLED` | `false` | Use OpenAI only when `true` and a nonempty API key is set |
| `OPENAI_API_KEY` | — | Required when `OPENAI_EMBEDDINGS_ENABLED=true`; also enables `natural_language_to_cypher` |

**Available local models (set via EMBEDDING_MODEL):**

See README.md for available models. BGE-base produces 768-dimensional vectors; CodeSage-base-v2 produces 1024-dimensional vectors. Dimensions alone do not determine quality or compatibility.

Use the same explicit model in every client sharing a sidecar and graph. Health checks and embedding responses must match the configured model and dimensions. Request errors never change providers. An explicit `OPENAI_EMBEDDINGS_ENABLED=false` overrides the deprecated `OPENAI_ENABLED` alias. An API key alone enables natural-language-to-Cypher while keeping embeddings local.

Changing models requires re-embedding code, notes, and bookmarks. Preserve their IDs and relationships by updating embedding properties in place. Vector indexes are shared across projects; do not drop them to repair one project. Upgrading the package does not migrate vectors. Graphs built with the previous CodeSage default should explicitly retain that model until migration.

## Environment Variables

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=PASSWORD

# Optional — local embeddings work without any of these
EMBEDDING_MODEL=BAAI/bge-base-en-v1.5
OPENAI_EMBEDDINGS_ENABLED=false # set true with a key to use OpenAI embeddings
OPENAI_API_KEY=sk-...            # also enables natural_language_to_cypher when set
```

## Commit Convention

Conventional Commits: `type(scope): description`
- feat, fix, docs, style, refactor, perf, test, chore
