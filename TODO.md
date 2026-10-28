# code-graph-context — Issues to Fix

## Embedding Model Configuration

### 1. Dimensions resolved statically, should be dynamic
- **File:** `src/core/embeddings/embeddings.service.ts:56-63`
- **Problem:** `getEmbeddingDimensions()` uses a hardcoded lookup table with a blind fallback (1536). Dimensions are resolved before the sidecar starts. If the user sets an unknown model, the dimensions may not match the actual model output, silently breaking Neo4j vector indexes.
- **Fix:** Query dimensions from the sidecar `/health` endpoint at runtime after model load. Make `getEmbeddingDimensions()` async or lazy-init from sidecar.

### 2. Init doesn't read model config from `.claude.json`
- **File:** `src/cli/cli.ts:298`
- **Problem:** `init` reads `EMBEDDING_MODEL` from shell env only (`process.env`), not from the MCP server's `env` block in `.claude.json`. Users must remember to pass the env var manually: `EMBEDDING_MODEL="..." code-graph-context init`.
- **Fix:** Have init optionally read from the MCP config file, or at minimum document the requirement clearly in the init output.

### 3. Qodo/Qwen `DynamicCache.get_usable_length` compatibility patch
- **Files:** `sidecar/embedding_server.py:44-83`, `src/cli/cli.ts:314,345`
- **Problem:** The Qodo model's custom `modeling_qwen.py` calls `DynamicCache.get_usable_length()` which was renamed to `get_seq_length()` in `transformers` 4.45+. Model downloads successfully but crashes on first encode.
- **Fix:** Add a monkey-patch in `load_model()` (same pattern as the existing Conv1D patch for CodeSage):
  ```python
  from transformers.cache_utils import DynamicCache
  if not hasattr(DynamicCache, 'get_usable_length'):
      DynamicCache.get_usable_length = DynamicCache.get_seq_length
  ```
  Also apply the same patch to the inline Python one-liners in `cli.ts` (lines 314 and 345) so init validation works too.

### 4. Init model size estimate is hardcoded to "~600MB"
- **File:** `src/cli/cli.ts:336`
- **Problem:** The download message says `~600MB` regardless of which model is being downloaded. Qodo is ~3 GB.
- **Fix:** Use a size lookup table or omit the size estimate.

### 5. `EMBEDDING_DIMENSIONS` table must be manually maintained
- **File:** `src/core/embeddings/embeddings.service.ts:32-44`
- **Problem:** Every supported model needs a manual entry. If a user picks a model not in the table, they get the wrong fallback dimensions. This is fragile and doesn't scale.
- **Fix:** Remove the static table entirely once dimensions are discovered dynamically from the sidecar (see #1).

## Memory and retrieval (from the 5.6.0 memory-scopes work)

Plan and measurements: `~/develop/docs/code-graph-context/plans/memory-scopes/` (proposal.md, run-log.md).

### 6. Similarity scores cannot separate relevant from nearest
- **Files:** `src/mcp/tools/session-recall.tool.ts` (`minSimilarity` default 0.3), `src/mcp/tools/search-codebase.tool.ts` (`DEFAULTS.searchMinSimilarity` 0.5)
- **Problem:** Scores are Neo4j's `(1 + cosine) / 2`, and with `BAAI/bge-base-en-v1.5` they sit in a narrow band: nonsense queries score 0.73 to 0.80, real matches 0.80 to 0.88. No threshold filters anything, so recall always returns `limit` notes and pads with weak ones. Seen live: a Kafka query on code-graph-context (no Kafka notes) returned five notes at 0.77 to 0.79.
- **Fix:** Build a small labeled set of relevant and irrelevant (query, note) pairs per project, measure cosine distributions, and calibrate a default per embedding model; consider thresholding on raw cosine and reporting it.

### 8. One filtered search per project until Neo4j 2026.06
- **File:** `src/storage/neo4j/project-vector-search.ts`
- **Problem:** Neo4j 2026.02 rejects `IN` and `OR` inside a vector `SEARCH` filter, so several projects need `UNWIND ... CALL (scopeId) { SEARCH ... }`.
- **Fix:** After upgrading to 2026.06 or later, which allows `IN`, collapse it into one search; the change stays inside this module.

### 11. Ingest dry runs now need Neo4j
- **Files:** `src/cli/ingest-cursordiff.ts`, the one-shot ingest tools, `src/mcp/services/cursordiff-watch-manager.ts`
- **Problem:** Mapping cwd roots to registered project ids and counting unknown deliberation ids read the store, so `dryRun` no longer works offline.
- **Fix:** Accept a root-to-id map as input for offline dry runs, or skip the mapping when Neo4j is unreachable and say so in the summary.

### 12. Decide whether to drop the Docker provider after 2026-10-30
- **Files:** `src/cli/neo4j-docker.ts`, `src/cli/select-neo4j-provider.ts`, `src/cli/migrate-from-docker*.ts`, `docker-compose.yml`
- **Context:** The owner runs native Neo4j (Homebrew, launchd). Docker stays in 5.6.0, pinned to `neo4j:2026.02.2-community`, because it is the only provider on Linux, Windows and macOS without Homebrew, and `migrate-from-docker --rollback` needs it until the owner's rollback window closes on 2026-10-30.
- **Decision then:** remove Docker only if the package is meant to be macOS plus Homebrew only; otherwise keep it as the cross-platform fallback.

### 13. Split the session tool handlers into services
- **Files:** `src/mcp/tools/session-recall.tool.ts` (about 500 lines, one 250-line closure, `any` rows), `src/mcp/tools/session-save.tool.ts` (one closure that validates, resolves, writes a bookmark and writes a note)
- **Problem:** Each tool is an MCP adapter and a workflow in one function, so the order of steps and who owns each one is hard to read, and rows are untyped.
- **Fix:** A `SessionRecallService` and `SessionSaveService` that return typed results, with the tools as thin adapters; type the Neo4j rows.

### 15. Runbench treats a Project without `kind` as a codebase
- **Files:** `~/coding/runbench/packages/hub/src/graph-client.ts`, `packages/orchestrator/src/graph-projects.ts`
- **Problem:** The server computes a missing kind with `projectKindCypher` (a path with no parse status is a `directory`); Runbench defaults to `codebase`. They differ only for nodes a pre-5.6 server wrote and the startup backfill has not yet reached.
- **Fix:** Use the same rule, or read `list_projects` instead of Cypher.

### 16. Incremental parse can mix embedding models under one stamp
- **File:** `src/mcp/handlers/incremental-parse.handler.ts`
- **Problem:** A watcher re-parse embeds changed nodes with the configured model and leaves the project's `embeddingModel` stamp alone, so a project parsed with one model and edited under another holds mixed vectors while its stamp names the old model.
- **Fix:** Compare the configured model with the stamp before an incremental parse; refuse with a message to re-parse fully, or re-stamp after a full re-embed.

### 17. Two data-directory overrides
- **Files:** `src/cli/neo4j-native.ts` (`CGC_NEO4J_HOME`), `src/core/utils/data-directory.ts` (`CGC_DATA_DIR`)
- **Problem:** Native Neo4j reads its own override, so the two can point at different roots.
- **Fix:** Derive the Neo4j home from `CGC_DATA_DIR` by default and keep `CGC_NEO4J_HOME` only as an explicit override.
