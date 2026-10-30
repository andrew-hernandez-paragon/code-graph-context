# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.8.2] - Recall Floor and Sidecar Hang - 2026-10-29

### Fixed

- **The embedding sidecar no longer hangs after about 1000 requests.** The server started it with stdout piped but never read it, and uvicorn writes an access line per request there. Once the pipe filled, the sidecar blocked, each request waited out the 120 s timeout, and the server restarted it. A busy session (each recall also calls `/rerank` since 5.8.0) hit this sooner. stdout is now ignored. (`src/core/embeddings/embedding-sidecar.ts`)
- **Note recall drops fewer relevant notes.** The reranker floor for `BAAI/bge-reranker-base` is 0.001 instead of 0.02. The cross-encoder scores a note low when it mentions the asked fact in passing, so 0.02 dropped 28% of the evidence on LongMemEval and returned 1.5 notes per recall. With 0.001, all evidence reaches the top 5 for 0.90 of LongMemEval S questions instead of 0.71, and 0.85 instead of 0.73 on a 100-question sample of M. On the 48 labeled recall queries, recall of relevant notes rises from 0.61 to 0.63 and precision falls from 0.44 to 0.40. Method and numbers: `docs/code-graph-context/research/longmemeval-2026-10.md` in the owner's docs tree. (`src/core/embeddings/embedding-config.ts`)

## [5.8.1] - Recall Tuning - 2026-10-29

### Changed

- **Note recall weights keyword matches three times the vector channel and uses RRF k=10.** A sweep over the 48 labeled recall queries found that with the reranker the merge settings barely matter, but without it (a sidecar older than 5.8.0, OpenAI embeddings, or `RERANK_MODEL=none`) these settings lift queries with a relevant note in the top 5 from 0.71 to 0.73 and the relevant share of returned notes from 0.28 to 0.35. With the reranker, recall of relevant notes moves from 0.60 to 0.62. (`src/mcp/handlers/note-search.ts`)

## [5.8.0] - Hybrid Recall - 2026-10-29

Note recall finds notes by keyword and through the code they are anchored to, not only by embedding, and a reranker orders what it finds. Code search shows the notes anchored to the code it matched.

### Added

- **Note recall searches three ways and reranks.** `session_recall` and the notes section of `query_signals` merge nearest notes by embedding, a keyword search over note topic and content (new full-text index `session_notes_fts_idx`, created at server start), and the notes anchored to files a code search of the query matched. A cross-encoder (`BAAI/bge-reranker-base`, in the embedding sidecar) orders the top 30 and drops notes scoring under 0.02. On 48 labeled real recall queries run through the server, a relevant note reached the top 5 for 0.83 of queries instead of 0.77, the relevant share of returned notes rose from 0.38 to 0.48, and recall of relevant notes from 0.58 to 0.69, at the same 3.9 notes per call and about 0.35 s more per recall. Each note reports `matchedBy` and `rerankScore`; `relevance` stays the vector similarity and is null for a note only keyword or code found. Method and numbers: `docs/code-graph-context/research/recall-v2.md` in the owner's docs tree. (`src/mcp/handlers/note-search.ts`)
- **The sidecar serves `POST /rerank`.** It loads the reranker in the background at start, downloading it on first use. `RERANK_MODEL` picks another cross-encoder, or turns reranking off with `none`. Without a reranker (an older shared sidecar, OpenAI embeddings, or `RERANK_MODEL=none`), recall keeps the merged order, and a note only the embedding found must still reach the calibrated floor.
- **`search_codebase` lists the notes anchored to its results.** `notes` holds up to five live notes anchored to a matched or traversed node, or naming a matched file in `aboutPaths`, each with its topic and the first 400 characters. A note reached through the traversal now shows its topic instead of a bare id. (`src/mcp/handlers/anchored-notes.ts`)

### Changed

- **`query_signals`' code section fuses keyword and vector search,** as `search_codebase` does, instead of vector only.
- A caller's `minSimilarity` on note recall now applies to notes only the embedding found, and replaces the reranker floor.

## [5.7.1] - Calibrated Recall - 2026-10-28

Note recall returns fewer weak matches by default.

### Changed

- **Note recall defaults to a similarity floor calibrated per embedding model.** For `BAAI/bge-base-en-v1.5` the floor is 0.80 on the tools' `(1 + cosine) / 2` scale, which is cosine 0.60. On 812 blind-labeled pairs from real recall queries, it raised the share of returned notes that are relevant from 0.31 to 0.39 and cut notes per call from 5.0 to 3.9, while recall of relevant notes fell only from 0.75 to 0.72. Other models keep 0.30. `session_recall` and the notes section of `query_signals` use it when `minSimilarity` is omitted; a caller's value still wins, `query_signals`' code section keeps 0.5, and bookmark matching, which was not measured, keeps 0.30. An empty recall now says no note was close enough. Method and numbers: `docs/code-graph-context/research/recall-relevance-calibration.md` in the owner's docs tree. (`src/core/embeddings/embedding-config.ts`)

## [5.7.0] - Memory Maintenance - 2026-10-28

Notes can move between projects, a project can be deleted without losing its memory, a project embedded with another model is reported instead of silently returning nothing, and upgrades keep the embedding sidecar's Python environment.

### Added

- **`code-graph-context project delete <project>`** removes a project and its graph data. Its notes, chunks and bookmarks must be moved (`--move-memory-to <project>`) or deleted (`--delete-memory`) explicitly; with neither, it refuses and prints the counts. Moved notes lose anchors into the deleted project and keep their file anchors; deliberations scoped to it are re-scoped to the target. `--dry-run` prints what would move and what would be deleted, and the command asks before deleting unless `--yes`. It is a CLI command only, because deleting a project is a decision for a person, not an agent. (`src/core/projects/project-deletion.service.ts`, `src/cli/project-delete.ts`)
- **`session_update` `moveToProjectId`** moves a note and its chunks to another project or collection, keeping its anchors.
- **Embedding stamps.** Each codebase records `embeddingModel` and `embeddingDimensions` when it is parsed, and startup backfills them from a stored vector. `list_projects` shows them, and `search_codebase`, `query_signals` (code) and `detect_duplicate_code` add a warning when a project was embedded with a model or dimension other than the server's, naming both and the fix (re-parse). Before, such a project's search returned nothing with no explanation. (`src/core/projects/project-embedding.ts`)

### Changed

- **The sidecar's Python environment lives at `~/.local/share/code-graph-context/sidecar-venv`** (under `CGC_DATA_DIR`), not inside the installed package, so `npm i -g` no longer deletes it and the first parse after an upgrade no longer times out rebuilding torch. Python is chosen in this order: `PYTHON_EXECUTABLE`, the new environment, a legacy `sidecar/.venv` in the package, system Python. `init` moves a legacy environment to the new path when it can, and installs dependencies with `python -m pip`. (`src/core/embeddings/sidecar-venv.ts`)

### Removed

- The note search's fallback to parent-only search when the chunk index was missing, chosen by matching error text. Server start creates every vector index, so a missing chunk index now surfaces as the error that names it.

## [5.6.0] - Memory Scopes - 2026-10-27

Memory works in any project, not only parsed codebases, and the server now tells agents how its tools fit together.

**Requires Neo4j 2026.02 or later.** Vector search now filters by project inside the index (CYPHER 25 `SEARCH` and `CREATE VECTOR INDEX ... WITH [n.projectId]`), which Neo4j 5.x rejects. On an older server, start logs one error naming the found version and skips the vector index rebuild, and `test_neo4j_connection` reports the version and whether filtered search is supported.

- **Native (Homebrew) users:** run `brew upgrade neo4j`. If the store is on 5.x, Neo4j needs 5.26 first; upgrading a 5.26 store in place works.
- **Docker users:** `init` now creates `neo4j:2026.02.2-community`, but an existing container keeps its image, and `init --force` refuses to recreate a 5.x container on its 5.x volume (the new image cannot open it). Run `code-graph-context migrate-from-docker`: it upgrades the store through 5.26 and moves it to the native Neo4j.

### Added

- **Project kinds.** A project is a `codebase` (parsed), a `directory` (a local directory that is not parsed) or a `collection` (a named set of memories with no directory). `create_project` registers a directory or a collection; `list_projects` shows each project's kind, memory counts and a `kinds` filter. A path inside a known project resolves to it, a git worktree to its main repository, and `session_save` on an unregistered git repository registers it as a directory. (`src/core/projects/`, `src/mcp/tools/create-project.tool.ts`)
- **Memory in any project.** `session_save` and `session_update` take `aboutPaths` (notes) and `workingSetPaths` (bookmarks); `session_recall` takes `projectIds` (up to 10) and reports `missingAboutPaths` and `changedAboutPaths`. (`src/mcp/tools/session-*.tool.ts`)
- **Server instructions.** The server sends instructions that name the project kinds and the order to use the tools in: recall before working, save after a discovery, check stale anchors, resume from a bookmark. (`src/mcp/constants.ts`, `src/mcp/create-server.ts`)
- **Tool annotations.** Every tool sets `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint: false` explicitly, so a client can run reads in parallel and retry safe calls.
- **`query_signals` `unresolvedProjectErrors`.** When some of `projectIds` do not resolve, `unresolvedProjectIds` lists those inputs and `unresolvedProjectErrors` holds the matching messages, each naming the next call.

### Changed

- **Tool descriptions open with what the tool does, in the words an agent searches with, and name the tool that supplies its inputs.** `list_projects` no longer calls itself rarely needed. Every tool's `projectId` reads the same.
- **Errors set `isError: true`**, so a client can tell a failure from a result. (`src/mcp/utils.ts`)
- **`search_codebase` `minSimilarity` defaults to 0.5**, not 0.65. It gates only the meaning (vector) match, on Neo4j's `(1 + cosine) / 2` score.
- **The server reports its name as `code-graph-context` and the package version**, not `codebase-graph` 1.0.0.
- **Vector search filters by project inside the index**, so a large project no longer crowds out a small one. The vector indexes are rebuilt on server start.

### Removed

- `TOOL_NAMES` entries for the retired `save_session_bookmark`, `restore_session_bookmark`, `save_session_note` and `recall_session_notes`, and the `backfill:projects` script.

## [5.5.2] - Search Match Scores - 2026-10-22

`search_codebase` returns every match's scores as JSON.

### Changed

- **`search_codebase` returns every match's scores as JSON.** The response gains `matches`: each hit in rank order, rank 1 being the node the traversal starts from, with `id`, `name`, `filePath`, `fusedScore`, `vectorScore` (Neo4j's `(1 + cosine) / 2`), `vectorCosine`, `lexicalScore` and `channels`. Before, the best match's score reached only the traversal's title, which the JSON drops, and the other matches came as prose appended after the JSON, so a caller had to parse text and could never score the best match. That prose section is gone. A start node with no connections now answers `{ "message": ..., "matches": [...] }` instead of a bare sentence. (`src/mcp/handlers/search-matches.ts`, `src/mcp/tools/search-codebase.tool.ts`)

## [5.5.1] - Indexed Node Lookups - 2026-10-16

Code node lookups by id and file path stopped scanning the whole database.

### Fixed

- **Node lookups by id, file path and note reference use indexes.** Queries like `MATCH (n {id: $id, projectId: $p})` had no label, so Neo4j planned an AllNodesScan over every node in the database (307,643 here). They now match `:GraphNode` with the id or file path in the pattern and seek `project_id_graphnode_idx` or the new `project_filepath_graphnode_idx`. Measured on the live 307,643-node graph, same parameters before and after: node by id 129 ms to 2 ms, file node ids 103 ms to 1 ms, node impact 118 ms to 2 ms, transitive dependents 316 ms to 3 ms, cross-file edges before a reparse 111 ms to 3 ms, pheromone target lookup in `swarm_sense` and `query_signals` 527 ms to 3 ms, and the stale `aboutNodeIds` count run after every parse 19,657 ms to 5 ms. The file delete, the edge recreation after a reparse, and the targets of `session_save`, `session_note`, `session_bookmark`, `session_update`, `swarm_pheromone` and `swarm_post_task` also seek instead of scan. The `NOT target:SessionNote ...` guards on those targets are gone because `:GraphNode` already excludes session and coordination nodes. (`src/storage/neo4j/neo4j.service.ts`, `src/mcp/tools/`, `src/mcp/handlers/traversal.handler.ts`)

### Added

- **Two `GraphNode` indexes**, `project_filepath_graphnode_idx` on `(projectId, filePath)` and `project_name_graphnode_idx` on `(projectId, name)`, created with the existing project indexes on each parse, and at every server start so a graph parsed by an older version gets them without a reparse. (`src/storage/neo4j/neo4j.service.ts`, `src/mcp/handlers/graph-generator.handler.ts`, `src/mcp/service-init.ts`)

### Changed

- **Note, bookmark, pheromone and task targets must be code nodes.** They now match `:GraphNode`, where before they matched any node except session and coordination labels. An `aboutNodeIds` entry naming a non-code node such as a `Deliberation` no longer links. On the measured graph every one of the 319 existing `ABOUT` targets was a `GraphNode`.

## [5.5.0] - Native Neo4j on macOS - 2026-10-16

On a Mac with Homebrew, code-graph-context runs Neo4j natively under its own launchd agent, with no Docker, and an existing Docker graph moves over with one command that keeps every node, relationship, embedding and index. Docker remains the provider on Linux and Windows, and on request.

### Added

- **`code-graph-context migrate-from-docker`** moves the graph from the Docker container into the native Neo4j. It records the source counts, stops the container and turns off its restart, dumps it, upgrades the store through a throwaway `neo4j:5.26` container when the source is older (Neo4j requires every upgrade from before 5.26 to pass through 5.26), loads it into the native Neo4j, and compares nodes, relationships, per-label counts and every index before switching the provider. The container and its volume are only stopped, never deleted, and `--rollback` brings the Docker graph back. `--from-dump <dir>` reuses an existing dump. Rehearsed on a copy of a 307,643-node graph: counts, all 17 indexes and vector search results matched, in 63 s. (`src/cli/migrate-from-docker.ts`)
- **Native Neo4j provider for macOS with Homebrew.** `init` installs `neo4j` if missing, generates a config from the installed stock `neo4j.conf` plus a managed block (127.0.0.1 listeners, heap, page cache, small transaction logs, APOC unrestricted, `db.query.default_language=CYPHER_5`), copies the APOC core jar, sets the initial password, and runs Neo4j under the launchd agent `dev.code-graph-context.neo4j` with its own conf, plugins and data in `~/.local/share/code-graph-context/neo4j`. Homebrew upgrades replace only the binaries. `--native` and `--docker` force a provider; the default is native on macOS with Homebrew and Docker elsewhere. If the Docker container is running on the same ports, `init` leaves it alone. (`src/cli/neo4j-native.ts`)
- **Provider record.** `init` writes `{ "neo4j": { "provider", "boltPort", "httpPort" } }` to `~/.config/code-graph-context/config.json` (directory overridable with `CGC_CONFIG_DIR`). (`src/cli/neo4j-provider-record.ts`)

### Changed

- **The MCP server probes Bolt before starting anything.** If `RETURN 1` answers at `NEO4J_URI`, no Docker call is made. Otherwise it starts the recorded provider and waits for Bolt; with no record it keeps the old Docker behavior, and without Docker it fails with "run code-graph-context init". (`src/mcp/neo4j-startup.ts`)
- **A failed Neo4j start no longer skips the startup steps for good.** The server retries every 30 s, up to 20 times, then runs the schema, migration, backfill and index steps. Previously one failed start skipped them until the next server start. (`src/mcp/service-init.ts`)
- **Readiness and APOC checks use Bolt for both providers** instead of `docker exec cypher-shell`. (`src/cli/neo4j-bolt.ts`)
- **`status` and `stop` follow the recorded provider.** `status` shows the provider, service state, Bolt reachability, APOC and the Neo4j version.
- **The launchd agent is disabled while the Docker graph owns the ports**, after `init` and after a rollback, so a login never starts both Neo4j servers on the same ports. Starting the native service enables it again.

### Upgrading

From a Docker install on macOS:

1. Install this version and run `code-graph-context init`. With the Docker graph still running it configures the native Neo4j, sets up the embedding server, and stops there.
2. Stop the clients that use the graph, then run `code-graph-context migrate-from-docker`. The graph is offline while it dumps and loads, about a minute for a 2 GB store.
3. Start your clients again. Nothing in their MCP configuration changes: the ports, user and password stay the same.

`code-graph-context migrate-from-docker --rollback` returns to the Docker graph. Delete the container and the `code-graph-neo4j-data` volume yourself once you no longer need them.

## [5.4.1] - Smaller Transaction Logs - 2026-10-16

### Changed

- **`init` keeps only the transaction logs crash recovery needs.** New containers get `db.tx_log.rotation.retention_policy=keep_none`, `db.tx_log.rotation.size=64M` and `db.tx_log.preallocate=false`. Neo4j's defaults keep two days of 256 MB log files, each allocated at full size when it opens, which only an incremental backup reads. A local code graph is rebuilt by reparsing, so those logs cost disk for nothing; one measured graph held 1 GB of them. (`src/cli/neo4j-docker.ts`)

### Upgrading

Docker fixes a container's settings when it is created, and Neo4j Community cannot change them at runtime, so an existing container keeps the old logs until it is recreated. Run `code-graph-context init --force`, with the same `--memory` and `--pagecache` you use today: it removes the container, keeps the `code-graph-neo4j-data` volume with your graph, and creates a container with the new settings. Check the settings with `SHOW SETTINGS YIELD name, value WHERE name STARTS WITH 'db.tx_log'`.

## [5.4.0] - Note Supersession and a Shared Embedding Server - 2026-10-16

Lets a new note replace older ones in one call, stops every server start from rewriting all notes, and lets any process start the local embedding server and keep it alive while it uses it.

### Added

- **`code-graph-context embeddings start`** makes sure a local embedding server is running and exits 0 once `/health` is ok, or 1 with the reason and the log path. It starts the server detached from the calling process, with output appended to `code-graph-context-embedding-sidecar.log` in the OS temp directory, and waits for a server that is still loading its model instead of starting a second one. Other tools, such as Runbench, call it before using the server over HTTP. (`src/cli/embeddings-start.ts`)
- **`session_save` takes `supersedes: string[]`**, the ids of older notes the new note replaces. In the same transaction as the create, each listed note in the same project gets `supersededBy` set to the new note's id, so recall hides it and returns the new note. The response's `note.supersedes` lists the ids it `marked` and the ids it did not find (`notFound`), including ids from another project. Passing `supersedes` on a bookmark-only save is rejected. (`src/mcp/tools/session-save.tool.ts`)

### Changed

- **The embedding server owns its idle shutdown.** It stops itself when no `/embed` request has arrived for `EMBEDDING_IDLE_TIMEOUT_S` seconds (default 600; `0` disables), counting requests from every client. Previously the 10-minute timer lived in the MCP server that spawned it and counted only that server's own calls, so a client calling the server directly lost it mid-use. `EMBEDDING_IDLE_TIMEOUT_MS` is still read and converted. `EMBEDDING_WATCH_PARENT=0` stops the server from exiting when its stdin closes, which a detached server needs. (`sidecar/embedding_server.py`, `src/core/embeddings/embedding-sidecar.ts`)
- **One launch path.** The MCP server and the CLI start the server through `launchEmbeddingServer` in `src/core/embeddings/embedding-server-launch.ts`, with the same Python resolution, model and arguments.

### Fixed

- **A server that went away is started again.** When the server the MCP server started, or found already running, stops answering, the next embedding request starts it again and retries once; an HTTP error response is not retried. Before, every later request failed until the MCP server restarted.
- **No second server while one is loading.** A start now tells "nothing listening" from "listening but loading" and waits for the loading server instead of spawning another on the same port.
- **The supersession guidance hid the replacement note.** The `session_update` description and header told callers to save the replacement with `supersededBy: <oldId>`, but `supersededBy` on save marks the new note itself as superseded, so recall hid the replacement and kept returning the old note. The guidance now teaches `supersedes`, and the `supersededBy` parameter says what it does. Pairs saved the old way stay as they are; fix one with `session_update` by clearing `supersededBy` on the new note and setting it on the old one. (`src/mcp/constants.ts`, `src/mcp/tools/session-update.tool.ts`)
- **The startup SessionNote migration no longer rewrites every note.** Its match included `n.supersededBy IS NULL`, which is true for every note without the property, so each start rewrote every current note and logged it as a migration. It now selects only notes missing `aboutNodeIds` or `lastValidated`, so a migrated graph logs nothing. (`src/mcp/service-init.ts`)

### Upgrading

`npm i -g` replaces the package directory, and with it `sidecar/.venv`. Run `code-graph-context init` after upgrading to rebuild it; with Neo4j already running, `init` leaves the container alone and only sets up the sidecar. The 5.3.0 note below says the sidecar rebuilds the venv on next use: it does not, and without the venv the server falls back to system Python and fails to load the model.

## [5.3.0] - Embedding Provenance, Evidence Preservation and Windows Support - 2026-09-08

Pins local embeddings to one known model, stops traversal and impact analysis from silently discarding evidence, makes session-note chunks survive a reparse, and unblocks the server on Windows.

### Changed

- **Local default model is now `BAAI/bge-base-en-v1.5` (768 dims), previously `codesage/codesage-base-v2`.** Chosen after a local comparison: CodeSage gave modest retrieval gains at much higher CPU encoding cost. See Upgrading below, this changes vector width.
- **`isOpenAIEnabled()` now requires both the flag and a key.** `OPENAI_EMBEDDINGS_ENABLED=true` alone is no longer enough; `OPENAI_API_KEY` must also be present. Prevents a half-configured install from selecting a provider it cannot reach. (`src/core/embeddings/embedding-config.ts`)
- **Provider and dimension resolution moved to `embedding-config.ts`**, out of `embeddings.service.ts`. `OPENAI_ENABLED` remains a deprecated alias, and an explicit `OPENAI_EMBEDDINGS_ENABLED` now overrides it in both directions, including `false`.

### Added

- **Sidecar model mismatch is rejected.** The sidecar reports its model at `/health`; a value that disagrees with `EMBEDDING_MODEL` now fails loudly instead of writing vectors of the wrong width into the index.
- **Embedding model provenance is recorded**, on nodes and on each session-note chunk, so a graph carries the model that produced it.
- **`PYTHON_EXECUTABLE`** overrides sidecar interpreter discovery.

### Fixed

- **Traversal falls back to relationship ranking when vectors are incompatible, and says so.** Previously an incompatible vector silently produced no ranking signal. (`src/mcp/handlers/traversal.handler.ts`)
- **`impact_analysis` analyzes every indexed symbol in a file** and reports unknown impact for a file it has no index for, rather than reporting an empty blast radius that reads as "safe to change". (`src/mcp/tools/impact-analysis.tool.ts`)
- **Session-note chunks survive a reparse** and refresh when a note changes; a missing chunk index is handled rather than thrown.
- **Windows startup**, three separate blockers: `startMcpServer()` passed a raw drive-letter path to `import()`, which the ESM loader rejects, now wrapped with `pathToFileURL()`; Docker status checks used single-quoted `--format` strings and `2>/dev/null`, neither of which `cmd.exe` interprets as a POSIX shell does; and Python resolution hardcoded the POSIX venv layout, ignoring `.venv/Scripts/python.exe`.
- **Debug logs are gated**, and regression-test artifacts are excluded from the published package.

### Upgrading

Existing graphs are unaffected **if `EMBEDDING_MODEL` is set explicitly**. Check it before upgrading:

- Set to `BAAI/bge-base-en-v1.5`: nothing to do.
- Set to anything else: unchanged, your setting still wins.
- **Not set at all**: the default moves from `codesage/codesage-base-v2` to `BAAI/bge-base-en-v1.5`, changing vector width. Your existing `embedded_nodes_idx` was built at the old dimension, so reparse with `clearExisting: true` to rebuild both nodes and index, or pin the old value with `EMBEDDING_MODEL=codesage/codesage-base-v2`.

The new mismatch check means a wrong-width configuration fails loudly at startup rather than corrupting the index.

Note that `npm i -g` replaces the package directory and takes `sidecar/.venv` with it. The sidecar rebuilds it on next use, which downloads torch (~1.1 GB) and can exceed `EMBEDDING_STARTUP_TIMEOUT_MS`. The first parse after an upgrade may fail on that timeout; retry once the rebuild finishes.

## [5.2.0] - Hybrid Code Search - 2026-09-07

`search_codebase` gains a BM25 keyword channel alongside the existing vector channel, fused by reciprocal rank. Vector-only retrieval cannot rank exact symbol names: cosine scores for symbols sharing a name stem sit inside a band a fraction of a point wide, so the exact match lands mid-pack and the graph traversal roots on the wrong node.

### Added

- **`code_fts_idx`** - a Neo4j FULLTEXT index on `:Embedded(name, sourceCode)`, covering the same nodes `embedded_nodes_idx` does. Both properties are already written at parse time, so this needs no ingest change, and Neo4j backfills the index from existing nodes when it is created. (`src/storage/neo4j/neo4j.service.ts`)
- **`searchCodeLexical`** - the BM25 channel. No `minSimilarity` gate: Lucene scores are unbounded and relative to the corpus, so an absolute floor means nothing across projects. The channel is capped by rank instead. (`src/mcp/handlers/query-signals.handler.ts`)
- **`buildLuceneQuery`** - escapes every Lucene reserved character, drops tokens with no letter or digit, caps term count at 32, and boosts the `name` field 3x over `sourceCode`. A query like `what does foo() do?` is matched literally instead of being parsed as grouping and wildcards.
- **`fuseRRF`** - reciprocal rank fusion, `1/(60 + rank)` per channel. Rank rather than raw score, because cosine is bounded 0..1 while BM25 is unbounded: the two orderings are comparable, the two scales are not.
- **`searchCodeHybrid`** - runs both channels in parallel, fuses, cuts to `topK`. Each channel is asked for a deeper pool than `topK` so fusion has something to reorder.

### Changed

- **`search_codebase` ranks on the fused score.** Result lines now report `rrf`, plus `vec` and `bm25` where each channel contributed, so a caller can see whether a result came from meaning, from keywords, or from both.

### Measured

Query `searchCodeRaw` against this repository's own graph:

| | rank of the exact function | score of #1 | gap to #2 |
|---|---|---|---|
| vector only | 3rd | 0.855 | 0.001 |
| BM25, name boosted | 1st | 19.52 | 7.2x |

The vector top five spanned 0.841 to 0.855, a band 0.014 wide. Plain-English queries go the other way, which is why this fuses the channels rather than replacing one with the other.

### Upgrading

No reparse and no re-embed. The index is created at MCP server startup by `ensureCodeFulltextIndex` (`src/mcp/service-init.ts`), and by `GraphGeneratorHandler.ensureIndexes` on the next parse. Creation is idempotent and non-fatal: if the index is absent, `searchCodeLexical` returns no rows and search degrades to vector-only rather than erroring.

### Known limitation

Neo4j ships no camelCase-splitting analyzer, so `searchCodeRaw` indexes as a single token. Querying that identifier as separate words (`search code raw`) does not hit it lexically. That query shape is what the vector channel answers, so the fused result is still correct.

## [5.1.0] - Consensus Dialogue Primitives - 2026-05-13

Adds three substrate-pure swarm_message categories so any multi-agent consensus protocol can run open dialogue with convergence/dissent detection. Current primary consumer is the `/deliberate` skill (v5.1 swarm-mediated dialogue replaces the v5.0 Opus synthesizer arbiter), but the primitives are skill-agnostic.

### Added

- **`position` category** — an agent's current stance on a topic. Content is freeform or structured JSON. Subsequent `position` from the same agentId in the same swarm supersedes the prior stance by timestamp. (`src/mcp/tools/swarm-constants.ts`)
- **`agree` category** — endorsement primitive. Content names what is being agreed to (stance summary, proposal id, label). N matching agree messages from N distinct agents = convergence; the consuming protocol picks N (unanimous, majority, etc.).
- **`dissent` category** — non-convergence primitive. Agent holds its position; content is rationale. Triggers escalation outside the agent panel.

### Why substrate, not skill

These three speech acts (state-position / endorse / refuse-to-converge) are universal in multi-agent consensus literature — FIPA ACL, Paxos/Raft, Robert's Rules all encode them. Keeping them at the swarm_message layer (not buried inside `/deliberate`) means future skills (negotiation, voting, multi-agent planning) inherit them for free. The graph's SwarmMessage nodes naturally capture the full dialogue trace by swarmId.

### Backward compatibility

Strictly additive — existing categories and existing message shapes unchanged. Zero risk for current swarm callers.

## [5.0.1] - Embedding Health Probe Fix - 2026-05-13

Fixes a latent bug where `query_signals` reported `embedding-provider-unavailable` even when a healthy embedding sidecar was listening on port 8787.

### Fixed

- **`probeEmbeddingsHealth` no longer short-circuits on `sidecar.isRunning`.** That flag is process-local (only true when the current MCP generation spawned the sidecar itself) and misreports externally-started or cross-generation sidecars. The probe now goes straight to the network `/health` endpoint; the 100ms timeout still provides wedge-prevention against a cold-loading sidecar that hasn't bound the port yet.
- **Symptom:** `query_signals` returned `code: { skipped: 'embedding-provider-unavailable' }` and `notes: { skipped: 'semantic-ranking-unavailable' }` despite `search_codebase` (which uses a different code path) returning vector results from the same sidecar. After fix, both `search_codebase` and `query_signals` see the same sidecar state.
- File: `src/mcp/handlers/query-signals.handler.ts`.

## [5.0.0] - Consensus Protocol & Deliberation Layer - 2026-05-11

Adds the deliberation primitive: a panel of opinionated lens-prompted architects writes positions on a topic, a synthesizer merges into a verdict (FOLLOW / ITERATE / ALTERNATIVE / NEED-MORE-INPUT), and everything persists as queryable graph nodes plus optional ADR. Major version bump reflects the magnitude of the new primitive, though every change is strictly additive — no breaking changes.

### Added — Deliberation / Position / Verdict preserved node types (0004)

- **Three new preserved labels** survive reparse like SessionNote / SessionBookmark / Pheromone:
  - `Deliberation { id, topic, projectIds[], mode, status, synthesisVerdict?, ts, aboutNodeIds?, triggeredBy?, sessionId? }` — `projectIds` is an array; cross-project deliberations are first-class
  - `Position { id, deliberationId, role, ts, content, claims[], evidence[], counterArgs[], status: 'asserted' | 'abstained', agentId? }` — structured claim/evidence/counter-arg artifact (MetaGPT-style, guards against dominant-voice anchoring at synthesis)
  - `Verdict { id, deliberationId, verdict, rationale, ts, recordedIn?, agentId? }`
- **Edges**: `HAS_POSITION`, `RESULTED_IN`, `ABOUT { kind }`, `SCOPED_TO` (one per project — fans out for multi-project deliberations), `CITES { kind }` (cross-project safe via the global unique node ID system). Future-proofing edges defined but populated lazily: `SUPERSEDES`, `CITED_BY`, `RESPONDS_TO`, `CONTRADICTS`.
- **Abstention as first-class output**: a panel where N-of-M roles abstain is itself a useful signal ("this question doesn't have perspective-dependent answers").

### Added — Deliberation JSONL ingestor (0004)

- New `src/ingestors/deliberate/` package mirroring the cursordiff ingestor shape — reads events (`deliberation-start`, `position-start`, `position-complete`, `verdict`, `deliberation-complete`) from `~/.local/share/nvim/cursordiff/deliberation.jsonl` and idempotently MERGEs Deliberation/Position/Verdict + edges.
- Per Deliberation, calls `ensureProjectNode` for each entry in `projectIds[]` and creates SCOPED_TO edges. Per Position, emits CITES edges for any cited nodes (citations can cross projects since node IDs are globally unique).

### Added — `ingest_deliberate_session` MCP tool + companions (0004)

- **`ingest_deliberate_session`** — `mode: 'one-shot' | 'watch'`. Watch mode debounces ~500ms and re-runs `planIngest` over full files (idempotent MERGE makes this safe).
- **`stop_ingest_deliberate_session`**, **`list_ingest_deliberate_watchers`** — companion lifecycle/observability tools.

### Added — ADR writer (0004)

- New `src/utils/adr-writer.ts` — `writeAdrIfNeeded(deliberation, verdict, decisionsDir = '~/develop/decisions/')`. Writes an ADR to `~/develop/decisions/NNNN-<slug>.md` only for `ALTERNATIVE` or `NEED-MORE-INPUT` verdicts (matches the `~/develop/CLAUDE.md` template). FOLLOW and ITERATE skip the ADR (keeps decisions/ signal-dense).

### Added — `/deliberate` skill at `~/.claude/skills/deliberate/` (0004)

- **`SKILL.md`** — user-invocable `/deliberate <topic>` skill. One-shot ADR mode for v1. Spawns the existing `architect` agent (`~/.claude/agents/architect.md`) three times in parallel with different lens prompts, collects structured Positions, runs a synth pass for the Verdict, persists via the new ingestor, optionally writes ADR.
- **`roles.md`** — Pragmatist / Perfectionist / Operations lens prompts, each with anti-flip clauses (per CAMEL findings) and `ABSTAIN-NO-UNIQUE-POSITION` as a valid output. User-extensible registry.

### Added — Cursordiff deliberation viewer (0011)

Lives in the separate cursordiff.nvim repo (not in code-graph-context, but ships in the same release window):

- New Lua module `lua/cursordiff/deliberation.lua` — fs-watches `~/.local/share/nvim/cursordiff/deliberation.jsonl` via `vim.uv.new_fs_event()`, renders incoming events into a floating window.
- **Jury-dashboard layout** for one-shot deliberations — vertical stack of role cards updating in place as positions complete; synthesis card lights up last.
- `:CursorDiffDeliberation [id]` user command. Auto-opens on `deliberation-start` (configurable). Dismissible with `q`.
- macOS fs-watch handles file-doesn't-exist-yet (2-second retry timer until first `/deliberate` run creates the file) and unreliable filename argument from kqueue.

### Breaking changes

None. Major bump reflects scope, not compatibility.

### Why this matters

The deliberation layer closes a quality loop on the *reasoning process*, mirroring how v4.2.0's lineage closes the loop on agent *output*. Combined with v4.4.0's QueryOutcome, the substrate now captures user judgment on three independent axes:
- Agent-produced hunks → Decision (v4.2.0)
- Query result citations → QueryOutcome (v4.4.0)
- Multi-perspective architectural decisions → Verdict + Position (this release)

Each is queryable, each is a closed feedback loop, each compounds with the others. Cross-project deliberations are first-class through `projectIds[]` and `SCOPED_TO` fan-out.

### Notes

- Mandatory baseline comparison (single-agent four-lens self-critique vs multi-agent panel) noted in the proposal is **deferred** — recommended follow-up evaluation work, not blocking ship.
- Rounds mode (`--rounds N` back-and-forth dialogue) and auto-fire on `architect-ALTERNATIVE` are v2.

## [4.4.0] - Query Outcome Instrumentation - 2026-05-11

Closes the feedback loop on the query side, mirroring v4.2.0's lineage on the action side. Additive; no breaking changes.

### Added — `queryId` on `query_signals` response (0010)

- Every `query_signals` invocation now includes a top-level `queryId: 'qry_<...>'`. Callers pass this back via `query_signals_outcome` when citing a result, closing a ranking-feedback loop.

### Added — `query_signals_outcome` MCP tool (0010)

- New tool: `query_signals_outcome({ queryId, citedResults: [{ resultId, source, sourceRank, citationKind? }], agentId?, projectId? })`.
- For each cited result, idempotently MERGEs a `QueryOutcome` node and a `CITED` edge to the underlying graph node (when resolvable across labels via the deterministic global-unique node IDs).
- Returns `{ outcomesRecorded, queryId }`.

### Added — `QueryOutcome` preserved node type (0010)

- New label: `QueryOutcome { id, queryId, projectId, citedResultId, citedSource, citedSourceRank, ts, agentId?, citationKind? }`
- New edge: `(QueryOutcome)-[:CITED]->(<cited node>)` — crosses labels using the global unique node ID system from v4.2.0.
- Added to `PRESERVED_LABELS` — survives reparse.

### Notes

- The cite-detector heuristic (proposed in 0010's spec to auto-observe LLM citations) is intentionally **not** in this release. It's a harness-level concern that doesn't fit cleanly inside an MCP tool. Callers (orchestrator, hyphae, future hook) invoke `query_signals_outcome` explicitly when they observe a citation. The substrate is ready when the upstream detection lands.
- Together with v4.2.0's Decision lineage, the substrate now captures user judgment on BOTH agent-produced hunks (Decision) and substrate-returned query results (QueryOutcome). Closed loops on both action and read paths.

## [4.3.0] - Continuous Cursordiff Ingestion - 2026-05-11

Extends the v4.2.0 lineage substrate with continuous (fs-watched) ingestion and a one-hop file-centric query path. Additive; no breaking changes.

### Added — `(ToolCall)-[:TOUCHED]->(SourceFile)` edge (0006)

- Cursordiff ingestor now MERGEs a `TOUCHED` edge from each ToolCall to every unique SourceFile its Hunks reference (matched on `(projectId, filePath)`).
- Deduplicates per `(toolCallId, filePath)` so multiple hunks on the same file produce exactly one edge.
- Silent skip when no SourceFile match exists (file outside any parsed project) — no error, no orphan edge.
- Effect: file-centric queries (`MATCH (sf:SourceFile)<-[:TOUCHED]-(tc:ToolCall)`) are now one hop instead of `SourceFile<-Hunk<-ToolCall` traversal.

### Added — `ingest_cursordiff_session` MCP tool with one-shot + fs-watch modes (0007)

- **`ingest_cursordiff_session`** — exposes the cursordiff JSONL ingestor as an MCP tool. Two modes:
  - `mode: 'one-shot'` — ingest current contents of `~/.local/share/nvim/cursordiff/{router,lineage,decisions}.jsonl`, return summary, exit.
  - `mode: 'watch'` — start a `@parcel/watcher` subscription on the dataDir; on file change (~500ms debounce), re-run `planIngest` over the full files. Idempotent MERGE makes re-ingestion safe; byte-offset tracking is used only as a "did anything change" signal. Returns watchId + paths.
- Optional params: `dataDir`, individual file overrides (`routerFile`, `lineageFile`, `decisionsFile`), `dryRun`, `tailOnly`.
- Idempotent: invoking `mode: 'watch'` for a dataDir already being watched returns the existing watcher info, doesn't spawn a duplicate.
- **`stop_ingest_cursordiff_session({ watchId | dataDir })`** — stops a watcher.
- **`list_ingest_cursordiff_watchers()`** — returns active watchers with `mode`, `lastActivityAt`, `lastErrorAt`, `lastError`, `rowsProcessed` for operational visibility.
- New in-memory singleton `cursordiff-watch-manager.ts` tracks watchers for the MCP server lifetime.

### Notes

- Watch mode is the substrate primitive that closes hyphae's continuous-aggregation gap. Combined with v4.2.0's ingestor, agent activity now flows into the graph passively as cursordiff sessions happen.
- Claude-side telemetry parity (0005) intentionally skipped in this release — the existing claude-code tool-call data shape doesn't yet have a hook surface that produces the JSONL format the ingestor expects. Revisit when that's wired.

## [4.2.0] - Phase 1 Substrate Foundation - 2026-05-11

Bundles three substrate improvements that together close the agent-action → user-decision feedback loop and add a unified cross-source query primitive. All changes additive; no breaking changes.

### Added — `query_signals` MCP tool (0002 + 0008 + 0013)

- **`query_signals`** — single MCP tool returning sectioned per-source results across `code`, `notes`, and `pheromones`. Replaces the three-call pattern (`search_codebase` + `session_recall` + `swarm_sense`) with one fan-out via `Promise.all`. Sectioned-per-source response, not fused — avoids the Reciprocal Rank Fusion asymmetric-universe failure mode.
- **Multi-projectId support** — accepts `projectIds: string[]` (hard cap 25 with `pLimit(8)` concurrency gate to bound Neo4j pool use) in addition to the backwards-compat single `projectId: string`. New `groupBy: 'source' | 'project'` parameter pivots the response between flat-with-`projectId`-field and per-project-keyed structures. Partial failures across multiple projectIds partition into `unresolvedProjectIds` rather than failing the whole call.
- **Sidecar fast-fail** — embedder health probe with 100ms timeout up front; on failure, code/notes (semantic) sections return `skipped: 'embedding-provider-unavailable'` / `skipped: 'semantic-ranking-unavailable'` immediately rather than wedging the tool for 120s.
- **`searchCodeRaw`** — reusable helper extracted from `search-codebase` for cross-tool composition. Logic-preserving refactor (guarded by new snapshot test).

### Added — ToolCall / Hunk / Decision lineage (0001)

- **Three new preserved node labels**:
  - `ToolCall { id, sessionId, projectId, source: 'cursordiff' | 'claude', toolName, model, kind, durationMs, success, ts, ... }`
  - `Hunk { id, toolCallId, filePath, oldStart, oldCount, newStart, newCount, oldHash, newHash, ts }`
  - `Decision { id, hunkId, outcome: 'accepted' | 'rejected' | 'edited' | 'abandoned', ts, byUser, sessionId }`
- **Two new edges**: `(ToolCall)-[:PRODUCED]->(Hunk)`, `(Hunk)-[:RESOLVED_BY]->(Decision)`
- **`source` discriminator property** on ToolCall — `'cursordiff' | 'claude'` — preempts schema migration when claude-side telemetry ships in a later phase.
- **All three labels added to `PRESERVED_LABELS`** — survive reparse like SessionNote / SessionBookmark / Pheromone.
- **`src/ingestors/cursordiff/`** — JSONL → graph ingestor reading `~/.local/share/nvim/cursordiff/{router,lineage,decisions}.jsonl` and idempotently MERGEing the three node types.
- **`src/cli/ingest-cursordiff.ts` + `npm run ingest:cursordiff`** — one-shot CLI entry point. fs-watch live mode deferred to a later phase.

### Added — Project node hygiene (0012)

- **`ensureProjectNode(resolver, projectId, opts)`** — idempotent MERGE that creates a Project node for any projectId. `ON CREATE SET` populates metadata when the node is new; `ON MATCH SET` is deliberately empty so existing parsed Projects are never clobbered with synthetic metadata.
- **Widened `validateProjectId`** — now accepts the canonical `proj_<12 hex chars>` form OR human-readable synthetic IDs like `proj_setup_hyphae` (regex `proj_<1–40 a-z0-9_-> `). Backwards-compatible: anything that previously passed still passes.
- **`isSyntheticProjectId(id)`** predicate for distinguishing synthetic IDs (anything not matching the 12-hex canonical form).
- **6 tool call-sites** (`session_save`, `session_note`, `session_bookmark`, `swarm_pheromone`, `swarm_post_task`, `swarm_message`) now `ensureProjectNode` between `resolveProjectIdOrError` and their writes. Closes a latent gap where `session_save` against synthetic projectIds silently failed.
- **`list_projects` gains `includeSynthetic: boolean = false`** — synthetic Project nodes hidden by default; opt in to see them.
- **`scripts/backfill-project-nodes.ts`** + **`npm run backfill:projects`** — one-shot retrofit script for existing graph state. Idempotent; safe to re-run.

### Added — Test infrastructure (0009)

- **Vitest** added as devDependency. New `npm test` script.
- **Snapshot test for `search_codebase`** at `src/mcp/tools/__tests__/search-codebase.snapshot.test.ts` — locks response shape across the `searchCodeRaw` extraction. 11 tests pass.

### Changed — internal only (no caller-visible effect)

- `LIST_PROJECTS_QUERY` Cypher: `WHERE $includeSynthetic OR coalesce(p.synthetic, false) = false`. Two callers beyond `list_projects` updated to pass `includeSynthetic: false` explicitly: `autoResolveProjectId` (utils.ts) and `initializeNeo4jSchema` (service-init.ts).
- `search-codebase.tool.ts` now consumes `searchCodeRaw` instead of inlining VECTOR_SEARCH directly.

### Notes

- Every change is additive. Tool input/output schemas unchanged except `list_projects` which gains an optional input.
- Pairs with the cursordiff.nvim Lua-side journal writers (separate Neovim plugin repo) — the JSONL files this release reads are produced there.
- The lineage pipeline (ToolCall → Hunk → Decision) is the missing closed-loop feedback signal that makes downstream queries like "which models produce hunks the user accepts vs rejects" expressible for the first time.

## [4.1.0] - Synchronous Cross-Agent Primitives - 2026-04-27

### Added (additive — non-breaking)

- **`'question'` task type** in `TASK_TYPES`. Asker posts via `swarm_post_task({ type: 'question', metadata: { askerAgentId, deadlineMs } })`, polls `swarm_get_tasks({ taskId })` until `status='completed'`, then reads the answer message. Closes the synchronous-RPC gap in mycel's stigmergic coordination.
- **`'answer'` message category** in `MESSAGE_CATEGORIES`. Designated answerer (typically orchestrator or domain-expert subagent) sends `swarm_message({ category: 'answer', toAgentId: <askerAgentId>, taskId, content })` after claiming the question task.
- **`QUESTION_DEFAULT_POLL_INTERVAL_MS` (10s) + `QUESTION_DEFAULT_POLL_BUDGET` (5)** constants for asker-side polling protocol. Default ~50s wait before halt-with-BLOCKED.md.
- **Tool description updates** on `swarm_post_task`, `swarm_message`, `swarm_get_tasks` documenting the question convention (asker / answerer flow + polling cadence).

### Notes

- Pure additive change to enums; existing callers using `type: 'implement' | 'refactor' | ...` and existing message categories are unaffected.
- No new tools, no schema migrations, no Neo4j changes.
- Mycel skill (`~/.cursor/skills/mycel/SKILL.md`) and agent prompts (`~/.cursor/agents/implementer.md`, `test-writer.md`, new `peer.md`) updated in lockstep to use the primitive — see `~/develop/plans/code-graph-context/swarm-question-primitive/proposal.md` for the full design.

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
