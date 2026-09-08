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
