import neo4j, { Driver, SessionMode } from 'neo4j-driver';

import { MAX_TRAVERSAL_DEPTH } from '../../constants.js';
import { getTimeoutConfig } from '../../core/config/timeouts.js';

import { getNeo4jConnection } from './neo4j-connection.js';
import { nearestNeighborsPerRow } from './project-vector-search.js';
import { CYPHER_25_PREFIX, createProjectFilteredVectorIndexQuery, VECTOR_INDEXES } from './vector-indexes.js';
export class Neo4jService {
  private driver: Driver;

  constructor() {
    this.driver = this.createDriver();
  }

  private createDriver() {
    const { uri, user, password } = getNeo4jConnection();
    const timeoutConfig = getTimeoutConfig();

    return neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: timeoutConfig.neo4j.connectionTimeoutMs,
      maxTransactionRetryTime: timeoutConfig.neo4j.queryTimeoutMs,
    });
  }

  public async run(query: string, params: Record<string, any> = {}) {
    return this.execute(query, params, neo4j.session.WRITE);
  }

  /** Runs a query in a read session, so Neo4j rejects any write it attempts. For Cypher this server did not write. */
  public async runReadOnly(query: string, params: Record<string, any> = {}) {
    return this.execute(query, params, neo4j.session.READ);
  }

  private async execute(query: string, params: Record<string, any>, defaultAccessMode: SessionMode) {
    const session = this.driver.session({ defaultAccessMode });
    const timeoutConfig = getTimeoutConfig();
    try {
      const result = await session.run(query, params, {
        timeout: timeoutConfig.neo4j.queryTimeoutMs,
      });
      return result.records.map((record) => record.toObject());
    } catch (error: any) {
      // Provide helpful error message for timeout
      if (error.code === 'Neo.TransientError.Transaction.Terminated') {
        throw new Error(
          `Neo4j query timed out after ${timeoutConfig.neo4j.queryTimeoutMs}ms. ` +
            'Consider simplifying the query or increasing NEO4J_QUERY_TIMEOUT_MS.',
        );
      }
      console.error('Error running query:', error);
      throw error;
    } finally {
      // Wrap session close in try-catch to avoid masking the original error
      try {
        await session.close();
      } catch (closeError) {
        // Log but don't re-throw to preserve original error
        console.warn('Error closing Neo4j session:', closeError);
      }
    }
  }

  public getDriver() {
    return this.driver;
  }

  /**
   * Close the Neo4j driver connection.
   * Should be called when the service is no longer needed to release resources.
   */
  public async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
    }
  }
}

/**
 * Labels preserved across project reparses.
 *
 * `CLEAR_PROJECT` deletes nodes scoped to a `projectId` so the parser can
 * rebuild code structure; the labels listed here represent persistent
 * memory and coordination state that must outlive a reparse:
 *
 * - `SessionNote`     — knowledge captured by agents (architectural,
 *                       insight, bug, decision, risk, todo).
 * - `SessionBookmark` — working-state snapshots for compaction recovery.
 * - `Pheromone`       — stigmergic coordination markers (notably
 *                       `kind: warning`, which is permanent by design).
 * - `Project`         — per-project metadata; preserving avoids the
 *                       upsert→clear→update no-op latent bug in
 *                       parse-typescript-project.tool.ts.
 *
 * SwarmTask and SwarmMessage are intentionally NOT preserved — they
 * are active-mycel-run state with TTL/cleanup of their own.
 *
 * To extend: add the new label here. Drift is expected to be low; the
 * denylist remains the single source of truth for "what is NOT code."
 */
export const PRESERVED_LABELS = [
  'SessionNote',
  'SessionNoteChunk',
  'SessionBookmark',
  'Pheromone',
  'Project',
  // Lineage nodes (proposal 0001-tool-call-decision-lineage). Plain labels
  // (not prefixed) because the `source` property discriminates extractor
  // origin ("cursordiff" | "claude") — see critic's required adjustment.
  'ToolCall',
  'Hunk',
  'Decision',
  // Query-feedback nodes (proposal 0010-query-signals-outcome). Preserved so
  // ranking-feedback data accumulates across reparses.
  'QueryOutcome',
  // Deliberation nodes (proposal 0004-consensus-protocol-deliberation). Preserved
  // so panel decisions, positions, and verdicts accumulate across reparses.
  'Deliberation',
  'Position',
  'Verdict',
] as const;

const buildLabelDenylistClause = (labels: readonly string[]): string =>
  labels.map((label) => `AND NOT n:${label}`).join(' ');

export const QUERIES = {
  // Project-scoped deletion — preserves persistent memory / coordination labels
  // (see PRESERVED_LABELS). Code nodes (SourceFile, ClassDeclaration, etc.) are
  // deleted so the parser can rebuild them; SessionNote/SessionBookmark/
  // Pheromone/Project survive. Edges from preserved nodes to deleted code nodes
  // are recreated post-parse via session-edge-recovery.helpers.ts.
  // Uses APOC batched deletion to avoid transaction memory limits.
  CLEAR_PROJECT: `
    CALL apoc.periodic.iterate(
      'MATCH (n) WHERE n.projectId = $projectId ${buildLabelDenylistClause(PRESERVED_LABELS)} RETURN n',
      'DETACH DELETE n',
      {batchSize: 1000, params: {projectId: $projectId}}
    )
    YIELD batches, total
    RETURN batches, total
  `,

  // Full project nuke — no denylist, deletes EVERYTHING including session/
  // coordination data for the project. For tests and explicit user-initiated
  // wipes only. Not exposed via the parse tool's surface.
  CLEAR_PROJECT_FORCE: `
    CALL apoc.periodic.iterate(
      'MATCH (n) WHERE n.projectId = $projectId RETURN n',
      'DETACH DELETE n',
      {batchSize: 1000, params: {projectId: $projectId}}
    )
    YIELD batches, total
    RETURN batches, total
  `,

  // Full database clear - use with caution, clears ALL projects
  // Uses APOC batched deletion to avoid transaction memory limits
  CLEAR_DATABASE: `
    CALL apoc.periodic.iterate(
      'MATCH (n) RETURN n',
      'DETACH DELETE n',
      {batchSize: 1000}
    )
    YIELD batches, total
    RETURN batches, total
  `,

  // Create indexes on projectId for efficient filtering across key node types
  CREATE_PROJECT_INDEX_EMBEDDED: 'CREATE INDEX project_embedded_idx IF NOT EXISTS FOR (n:Embedded) ON (n.projectId)',
  CREATE_PROJECT_INDEX_SOURCEFILE:
    'CREATE INDEX project_sourcefile_idx IF NOT EXISTS FOR (n:SourceFile) ON (n.projectId)',

  // Create composite indexes on projectId + id for efficient lookups
  CREATE_PROJECT_ID_INDEX_EMBEDDED:
    'CREATE INDEX project_id_embedded_idx IF NOT EXISTS FOR (n:Embedded) ON (n.projectId, n.id)',
  CREATE_PROJECT_ID_INDEX_SOURCEFILE:
    'CREATE INDEX project_id_sourcefile_idx IF NOT EXISTS FOR (n:SourceFile) ON (n.projectId, n.id)',

  // Create composite index on GraphNode for efficient edge resolution lookups
  CREATE_PROJECT_ID_INDEX_GRAPHNODE:
    'CREATE INDEX project_id_graphnode_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.projectId, n.id)',
  CREATE_PROJECT_FILEPATH_INDEX_GRAPHNODE:
    'CREATE INDEX project_filepath_graphnode_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.projectId, n.filePath)',
  CREATE_PROJECT_NAME_INDEX_GRAPHNODE:
    'CREATE INDEX project_name_graphnode_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.projectId, n.name)',

  // Create index on normalizedHash for efficient structural duplicate detection
  CREATE_NORMALIZED_HASH_INDEX: 'CREATE INDEX normalized_hash_idx IF NOT EXISTS FOR (n:Embedded) ON (n.normalizedHash)',

  CREATE_NODE: `
    UNWIND $nodes AS nodeData
    CALL apoc.create.node(nodeData.labels, nodeData.properties) YIELD node
    RETURN count(*) as created
  `,

  CREATE_RELATIONSHIP: `
    UNWIND $edges AS edgeData
    MATCH (start:GraphNode) WHERE start.id = edgeData.startNodeId AND start.projectId = $projectId
    MATCH (end:GraphNode) WHERE end.id = edgeData.endNodeId AND end.projectId = $projectId
    WITH start, end, edgeData
    CALL apoc.create.relationship(start, edgeData.type, edgeData.properties, end) YIELD rel
    RETURN count(*) as created
  `,

  CREATE_INDEX: (label: string, property: string) => `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${property})`,

  GET_STATS: `
    MATCH (n)
    WHERE n.projectId = $projectId
    RETURN labels(n)[0] as nodeType, count(*) as count
    ORDER BY count DESC
  `,

  CREATE_EMBEDDED_VECTOR_INDEX: (dimensions: number) =>
    createProjectFilteredVectorIndexQuery(VECTOR_INDEXES.embeddedNodes, dimensions),

  // Lexical companion to embedded_nodes_idx. Covers the same :Embedded nodes
  // over two properties already written at parse time, so it needs no ingest
  // change and Neo4j backfills it from existing nodes when it is created.
  //
  // standard-no-stop-words rather than standard: code queries legitimately
  // contain `if`, `for` and `return`, and a stop-word filter would drop them.
  // Neo4j ships no camelCase-splitting analyzer, so `searchCodeRaw` indexes as
  // a single token. Exact identifier queries hit; the same identifier typed as
  // separate words does not, which is what the vector channel is for.
  CREATE_EMBEDDED_FULLTEXT_INDEX: `
  CREATE FULLTEXT INDEX code_fts_idx IF NOT EXISTS
  FOR (n:Embedded) ON EACH [n.name, n.sourceCode]
  OPTIONS {indexConfig: {
    \`fulltext.analyzer\`: 'standard-no-stop-words'
  }}
`,

  CREATE_SESSION_NOTES_VECTOR_INDEX: (dimensions: number) =>
    createProjectFilteredVectorIndexQuery(VECTOR_INDEXES.sessionNotes, dimensions),

  // Parent-child GraphRAG: long SessionNote content is also chunked into
  // :SessionNoteChunk nodes linked back via :PART_OF. Each chunk gets its
  // own embedding so vector recall surfaces specific facts buried in long
  // architectural notes; renderers always traverse :PART_OF to return the
  // parent SessionNote for display.
  CREATE_SESSION_NOTE_CHUNKS_VECTOR_INDEX: (dimensions: number) =>
    createProjectFilteredVectorIndexQuery(VECTOR_INDEXES.sessionNoteChunks, dimensions),

  // Lookup index for chunks-by-parent and projectId-filtered scans.
  CREATE_SESSION_NOTE_CHUNK_INDEX:
    'CREATE INDEX session_note_chunk_idx IF NOT EXISTS FOR (c:SessionNoteChunk) ON (c.projectId, c.parentNoteId)',

  CREATE_SESSION_NOTE_CHUNK_QUERY: `
    MATCH (parent:SessionNote {id: $noteId, projectId: $projectId})
    WHERE parent.content = $parentContent
    CREATE (c:SessionNoteChunk {
      id: $chunkId,
      projectId: $projectId,
      parentNoteId: $noteId,
      chunkIndex: $chunkIndex,
      content: $content,
      estimatedTokens: $estimatedTokens,
      embedding: $embedding,
      embeddingProvider: $embeddingProvider,
      embeddingModel: $embeddingModel,
      embeddingDimensions: size($embedding),
      createdAt: timestamp()
    })
    MERGE (c)-[:PART_OF]->(parent)
    RETURN c.id AS id
  `,

  SET_NOTE_CHUNK_EMBEDDING_QUERY: `
    MATCH (c:SessionNoteChunk {id: $chunkId, projectId: $projectId})
    SET c.embedding = $embedding,
        c.embeddingProvider = $embeddingProvider,
        c.embeddingModel = $embeddingModel,
        c.embeddingDimensions = size($embedding)
    RETURN c.id AS id
  `,

  // Delete all chunks belonging to a parent SessionNote (used by backfill /
  // re-chunking — never used for note deletion since note deletion isn't a
  // supported operation today).
  DELETE_NOTE_CHUNKS_QUERY: `
    MATCH (c:SessionNoteChunk {projectId: $projectId, parentNoteId: $noteId})
    DETACH DELETE c
  `,

  CREATE_SESSION_BOOKMARKS_VECTOR_INDEX: (dimensions: number) =>
    createProjectFilteredVectorIndexQuery(VECTOR_INDEXES.sessionBookmarks, dimensions),

  SET_NOTE_EMBEDDING_QUERY: `
    MATCH (n:SessionNote {id: $noteId, projectId: $projectId})
    SET n.embedding = $embedding,
        n.embeddingProvider = $embeddingProvider,
        n.embeddingModel = $embeddingModel,
        n.embeddingDimensions = size($embedding)
    RETURN n.id AS noteId
  `,

  SET_BOOKMARK_EMBEDDING_QUERY: `
    MATCH (b:SessionBookmark {id: $bookmarkId, projectId: $projectId})
    SET b.embedding = $embedding,
        b.embeddingProvider = $embeddingProvider,
        b.embeddingModel = $embeddingModel,
        b.embeddingDimensions = size($embedding)
    RETURN b.id AS bookmarkId
  `,

  // Indexes for efficient SessionBookmark and SessionNote lookups
  CREATE_SESSION_BOOKMARK_INDEX:
    'CREATE INDEX session_bookmark_idx IF NOT EXISTS FOR (n:SessionBookmark) ON (n.projectId, n.sessionId)',
  CREATE_SESSION_NOTE_INDEX:
    'CREATE INDEX session_note_idx IF NOT EXISTS FOR (n:SessionNote) ON (n.projectId, n.sessionId)',
  CREATE_SESSION_NOTE_CATEGORY_INDEX:
    'CREATE INDEX session_note_category_idx IF NOT EXISTS FOR (n:SessionNote) ON (n.projectId, n.category)',

  // Check if index exists
  CHECK_VECTOR_INDEX: `
    SHOW INDEXES YIELD name, type
    WHERE name = 'node_embedding_idx' AND type = 'VECTOR'
    RETURN count(*) > 0 as exists
  `,

  GET_SOURCE_FILE_TRACKING_INFO: `
    MATCH (sf:SourceFile)
    WHERE sf.projectId = $projectId
    RETURN sf.filePath AS filePath,
           COALESCE(sf.mtime, 0) AS mtime,
           COALESCE(sf.size, 0) AS size,
           COALESCE(sf.contentHash, '') AS contentHash
  `,

  // Get cross-file edges before deletion (edges where one endpoint is outside the subgraph)
  // These will be recreated after import using deterministic IDs
  // Uses filePath matching instead of relationship traversal to avoid following INJECTS/IMPORTS
  GET_CROSS_FILE_EDGES: `
    MATCH (n:GraphNode)
    WHERE n.filePath IN $filePaths AND n.projectId = $projectId
    WITH collect(DISTINCT n) AS nodesToDelete
    UNWIND nodesToDelete AS node
    MATCH (node)-[r]-(other)
    WHERE NOT other IN nodesToDelete AND other.projectId = $projectId
    RETURN DISTINCT
      startNode(r).id AS startNodeId,
      endNode(r).id AS endNodeId,
      type(r) AS edgeType,
      properties(r) AS edgeProperties
  `,

  // Delete source file subgraphs (nodes and all their edges)
  // Uses filePath matching to delete only nodes belonging to the specified files
  // Avoids following INJECTS/IMPORTS edges which would delete nodes from other files
  DELETE_SOURCE_FILE_SUBGRAPHS: `
    MATCH (n:GraphNode)
    WHERE n.filePath IN $filePaths AND n.projectId = $projectId
    DETACH DELETE n
  `,

  // Recreate cross-file edges after import (uses deterministic IDs)
  RECREATE_CROSS_FILE_EDGES: `
    UNWIND $edges AS edge
    MATCH (startNode:GraphNode {id: edge.startNodeId, projectId: $projectId})
    MATCH (endNode:GraphNode {id: edge.endNodeId, projectId: $projectId})
    CALL apoc.create.relationship(startNode, edge.edgeType, edge.edgeProperties, endNode) YIELD rel
    RETURN count(rel) AS recreatedCount
  `,

  // ── Session/coordination edge recovery (Phase 1.4) ──────────────────────
  //
  // After CLEAR_PROJECT (which preserves SessionNote/Bookmark/Pheromone/Project),
  // code nodes are recreated with deterministic IDs. The :ABOUT/:REFERENCES/
  // :MARKS edges to those code nodes were dropped by DETACH DELETE; recreate
  // them by matching the new code nodes against the persisted ID arrays.
  //
  // All queries are MERGE-based and idempotent. Targets match :GraphNode, which
  // excludes the session and coordination labels.

  // SessionNote -[:ABOUT]-> code  (uses aboutNodeIds property added in 1.3)
  // Notes and bookmarks in any project may anchor to the reparsed project's code, so they are found by
  // node id prefix ($projectIdPrefix = projectId + ':'), not by their own projectId.
  RECREATE_ABOUT_EDGES: `
    MATCH (n:SessionNote)
    WHERE any(id IN coalesce(n.aboutNodeIds, []) WHERE id STARTS WITH $projectIdPrefix)
    UNWIND n.aboutNodeIds AS aboutId
    WITH n, aboutId
    WHERE aboutId STARTS WITH $projectIdPrefix
    MATCH (target:GraphNode {id: aboutId, projectId: $projectId})
    MERGE (n)-[r:ABOUT]->(target)
    RETURN count(r) AS recreated
  `,

  // SessionNote -[:ABOUT]-> SourceFile for anchor paths under the reparsed codebase's root
  RECREATE_ABOUT_PATH_EDGES: `
    MATCH (n:SessionNote)
    WHERE $rootPrefix IS NOT NULL
      AND any(path IN coalesce(n.aboutPaths, []) WHERE path STARTS WITH $rootPrefix)
    UNWIND n.aboutPaths AS aboutPath
    WITH n, aboutPath
    WHERE aboutPath STARTS WITH $rootPrefix
    MATCH (file:SourceFile {projectId: $projectId, filePath: aboutPath})
    MERGE (n)-[r:ABOUT]->(file)
    RETURN count(r) AS recreated
  `,

  // SessionBookmark -[:REFERENCES]-> code  (workingSetNodeIds already a property)
  RECREATE_REFERENCES_EDGES: `
    MATCH (b:SessionBookmark)
    WHERE any(id IN coalesce(b.workingSetNodeIds, []) WHERE id STARTS WITH $projectIdPrefix)
    UNWIND b.workingSetNodeIds AS targetId
    WITH b, targetId
    WHERE targetId STARTS WITH $projectIdPrefix
    MATCH (target:GraphNode {id: targetId, projectId: $projectId})
    MERGE (b)-[r:REFERENCES]->(target)
    RETURN count(r) AS recreated
  `,

  // SessionBookmark -[:REFERENCES]-> SourceFile for working set paths under the reparsed codebase's root
  RECREATE_REFERENCES_PATH_EDGES: `
    MATCH (b:SessionBookmark)
    WHERE $rootPrefix IS NOT NULL
      AND any(path IN coalesce(b.workingSetPaths, []) WHERE path STARTS WITH $rootPrefix)
    UNWIND b.workingSetPaths AS workingSetPath
    WITH b, workingSetPath
    WHERE workingSetPath STARTS WITH $rootPrefix
    MATCH (file:SourceFile {projectId: $projectId, filePath: workingSetPath})
    MERGE (b)-[r:REFERENCES]->(file)
    RETURN count(r) AS recreated
  `,

  // Pheromone -[:MARKS]-> code  (nodeId already a property; if it was a
  // filePath sentinel because resolution failed at create time, the MATCH
  // simply finds nothing and the pheromone stays unlinked — matches existing
  // swarm-pheromone.tool.ts behavior).
  RECREATE_MARKS_EDGES: `
    MATCH (p:Pheromone {projectId: $projectId})
    WHERE p.nodeId IS NOT NULL
    MATCH (target:GraphNode {id: p.nodeId, projectId: $projectId})
    MERGE (p)-[r:MARKS]->(target)
    RETURN count(r) AS recreated
  `,

  // Stale-reference detection — counts SessionNote.aboutNodeIds entries that
  // do not resolve to a current node in the graph. Surfaced in parse summary
  // so users see which notes have orphaned references after reparse.
  COUNT_STALE_ABOUT_REFS: `
    MATCH (n:SessionNote)
    WHERE any(id IN coalesce(n.aboutNodeIds, []) WHERE id STARTS WITH $projectIdPrefix)
    UNWIND n.aboutNodeIds AS aboutId
    WITH n, aboutId
    WHERE aboutId STARTS WITH $projectIdPrefix
    OPTIONAL MATCH (target:GraphNode {id: aboutId, projectId: $projectId})
    WITH n.id AS noteId, aboutId, target
    WHERE target IS NULL
    RETURN count(*) AS staleCount
  `,

  // Note: Dangling edge cleanup is not needed because:
  // 1. DETACH DELETE removes all edges when deleting nodes
  // 2. Edges cannot exist without both endpoints in Neo4j
  // The previous query (WHERE startNode(r) IS NULL OR endNode(r) IS NULL) could never match anything

  // Get existing nodes (excluding files being reparsed) for edge target matching
  // Returns minimal info needed for edge detection: id, name, coreType, semanticType
  // NOTE: Using property-based query instead of path traversal to avoid Cartesian explosion
  // The old query `MATCH (sf:SourceFile)-[*]->(n)` caused OOM with large graphs
  GET_EXISTING_NODES_FOR_EDGE_DETECTION: `
    MATCH (n:GraphNode)
    WHERE n.projectId = $projectId
      AND n.filePath IS NOT NULL
      AND NOT n.filePath IN $excludeFilePaths
    RETURN DISTINCT n.id AS id,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           labels(n) AS labels,
           n.filePath AS filePath
  `,

  EXPLORE_ALL_CONNECTIONS: (
    maxDepth: number = MAX_TRAVERSAL_DEPTH,
    direction: 'OUTGOING' | 'INCOMING' | 'BOTH' = 'BOTH',
    relationshipTypes?: string[],
  ) => {
    const safeMaxDepth = Math.min(Math.max(maxDepth, 1), MAX_TRAVERSAL_DEPTH);

    // Build relationship pattern based on direction
    // For INCOMING, we reverse the match order: (connected)-[*]->(start) instead of (start)<-[*]-(connected)
    // This is because Neo4j variable-length patterns like <-[*1..N]- require ALL edges to point toward start,
    // but in multi-hop paths (A→B→C), intermediate edges (A→B) don't point toward C, causing 0 results.
    let relPattern = '';
    let isReversed = false;
    if (direction === 'OUTGOING') {
      relPattern = `-[*1..${safeMaxDepth}]->`;
    } else if (direction === 'INCOMING') {
      relPattern = `-[*1..${safeMaxDepth}]->`; // Same pattern as OUTGOING
      isReversed = true; // But we'll reverse start/connected in MATCH
    } else {
      relPattern = `-[*1..${safeMaxDepth}]-`;
    }

    // Build relationship type filter if specified
    // SECURITY: Validate relationship types to prevent Cypher injection
    // Only allow uppercase letters and underscores (valid Neo4j relationship type format)
    let relTypeFilter = '';
    if (relationshipTypes && relationshipTypes.length > 0) {
      const validRelTypePattern = /^[A-Z_]+$/;
      const validatedTypes = relationshipTypes.filter((t) => validRelTypePattern.test(t));
      if (validatedTypes.length !== relationshipTypes.length) {
        console.warn(
          'Some relationship types were filtered out due to invalid format. Valid format: uppercase letters and underscores only.',
        );
      }
      if (validatedTypes.length > 0) {
        const types = validatedTypes.map((t) => `'${t}'`).join(', ');
        relTypeFilter = `AND all(rel in relationships(path) WHERE type(rel) IN [${types}])`;
      }
    }

    // For INCOMING, reverse the match: (connected)-[*]->(start) finds nodes that can REACH start
    const matchPattern = isReversed ? `(connected)${relPattern}(start)` : `(start)${relPattern}(connected)`;

    return `
      MATCH (start:GraphNode {id: $nodeId, projectId: $projectId})

      CALL {
        WITH start
        MATCH path = ${matchPattern}
        WHERE connected <> start AND connected.projectId = $projectId
        ${relTypeFilter}
        WITH path, connected, length(path) as depth

        RETURN {
          id: connected.id,
          labels: labels(connected),
          properties: apoc.map.removeKeys(properties(connected), ['embedding', 'contentHash', 'mtime', 'size'])
        } as node,
        depth,
        [rel in relationships(path) | {
          type: type(rel),
          start: startNode(rel).id,
          end: endNode(rel).id,
          properties: properties(rel)
        }] as relationshipChain

      }

      WITH start, collect({
        node: node,
        depth: depth,
        relationshipChain: relationshipChain
      }) as allConnections

      WITH start, allConnections,
           allConnections[$skip..] as connections

      RETURN {
        startNode: {
          id: start.id,
          labels: labels(start),
          properties: apoc.map.removeKeys(properties(start), ['embedding', 'contentHash', 'mtime', 'size'])
        },
        connections: connections,
        totalConnections: size(allConnections),
        graph: {
          nodes: [conn in connections | conn.node] + [{
            id: start.id,
            labels: labels(start),
            properties: apoc.map.removeKeys(properties(start), ['embedding', 'contentHash', 'mtime', 'size'])
          }],
          relationships: reduce(rels = [], conn in connections | rels + conn.relationshipChain)
        }
      } as result
    `;
  },

  /**
   * DEPTH-BY-DEPTH WEIGHTED TRAVERSAL
   *
   * This query is called once per depth level, allowing you to score and prune
   * at each level before deciding which nodes to explore further.
   *
   * Parameters:
   *   $sourceNodeIds: string[] - Node IDs to explore FROM (starts with just start node)
   *   $visitedNodeIds: string[] - Node IDs already visited (to avoid cycles)
   *   $queryEmbedding: number[] - The original query embedding for similarity scoring
   *   $currentDepth: number - Which depth level we're at (1-indexed)
   *   $depthDecay: number - Decay factor per depth (e.g., 0.85 means 15% penalty per level)
   *   $maxNodesPerDepth: number - Maximum nodes to return at this depth
   *   $direction: 'OUTGOING' | 'INCOMING' | 'BOTH'
   *
   * How it works:
   *
   * 1. UNWIND $sourceNodeIds - For each node we're exploring FROM
   * 2. MATCH neighbors - Find all immediate neighbors (1 hop only)
   * 3. Filter out visited nodes - Avoid cycles
   * 4. Score each neighbor using:
   *    - edgeWeight: The relationshipWeight we added to edges (how important is this relationship type?)
   *    - nodeSimilarity: Cosine similarity between neighbor's embedding and query embedding
   *    - depthPenalty: Exponential decay based on current depth
   * 5. Combine: score = edgeWeight * nodeSimilarity * depthPenalty
   * 6. ORDER BY score DESC, LIMIT to top N
   * 7. Return scored neighbors - caller decides which to explore at next depth
   *
   * Example flow:
   *   Depth 1: sourceNodeIds=[startNode], returns top 5 neighbors with scores
   *   Depth 2: sourceNodeIds=[top 3 from depth 1], returns top 5 neighbors of those
   *   Depth 3: sourceNodeIds=[top 3 from depth 2], returns top 5 neighbors of those
   *   ...until maxDepth reached or no more neighbors
   */
  EXPLORE_DEPTH_LEVEL: (direction: 'OUTGOING' | 'INCOMING' | 'BOTH' = 'BOTH', maxNodesPerDepth: number = 5) => {
    // Build relationship pattern based on direction
    let relPattern = '';
    if (direction === 'OUTGOING') {
      relPattern = '-[rel]->';
    } else if (direction === 'INCOMING') {
      relPattern = '<-[rel]-';
    } else {
      relPattern = '-[rel]-';
    }

    return `
      // Unwind the source nodes we're exploring from
      UNWIND $sourceNodeIds AS sourceId
      MATCH (source:GraphNode {id: sourceId, projectId: $projectId})

      // Find immediate neighbors (exactly 1 hop)
      MATCH (source)${relPattern}(neighbor)

      // Filter: skip already visited nodes and ensure same project
      WHERE NOT neighbor.id IN $visitedNodeIds AND neighbor.projectId = $projectId
        AND ($relationshipTypes IS NULL OR type(rel) IN $relationshipTypes)

      WITH source, neighbor, rel,
           CASE
             WHEN neighbor.embedding IS NULL OR $queryEmbedding IS NULL THEN 'missing'
             WHEN size(neighbor.embedding) <> size($queryEmbedding) THEN 'dimension_mismatch'
             WHEN size(neighbor.embedding) = 0
               OR none(value IN neighbor.embedding WHERE value <> 0)
               OR none(value IN $queryEmbedding WHERE value <> 0) THEN 'zero_vector'
             ELSE 'compatible'
           END AS embeddingStatus

      // Calculate the three scoring components
      WITH source, neighbor, rel, embeddingStatus,

           // 1. Edge weight: how important is this relationship type?
           //    Falls back to 0.5 if not set
           COALESCE(rel.relationshipWeight, 0.5) AS edgeWeight,

           // 2. Node similarity: how relevant is this node to the query?
           // Incompatible vectors retain the same structural weight as missing embeddings.
           CASE
             WHEN embeddingStatus = 'compatible'
             THEN vector.similarity.cosine(neighbor.embedding, $queryEmbedding)
             ELSE 0.5
           END AS nodeSimilarity,

           // 3. Depth penalty: exponential decay
           //    depth 1: decay^0 = 1.0 (no penalty)
           //    depth 2: decay^1 = 0.85 (if decay=0.85)
           //    depth 3: decay^2 = 0.72
           //    This ensures closer nodes are preferred
           ($depthDecay ^ ($currentDepth - 1)) AS depthPenalty

      // Combine into final score
      WITH source, neighbor, rel, embeddingStatus, edgeWeight, nodeSimilarity, depthPenalty,
           (edgeWeight * nodeSimilarity * depthPenalty) AS combinedScore

      // Return all neighbor data with scores
      RETURN {
        node: {
          id: neighbor.id,
          labels: labels(neighbor),
          properties: apoc.map.removeKeys(properties(neighbor), ['embedding', 'contentHash', 'mtime', 'size'])
        },
        relationship: {
          type: type(rel),
          startNodeId: startNode(rel).id,
          endNodeId: endNode(rel).id,
          properties: properties(rel)
        },
        sourceNodeId: source.id,
        scoring: {
          embeddingStatus: embeddingStatus,
          edgeWeight: edgeWeight,
          nodeSimilarity: nodeSimilarity,
          depthPenalty: depthPenalty,
          combinedScore: combinedScore
        }
      } AS result

      // Sort by score and limit to top N per depth
      ORDER BY combinedScore DESC
      LIMIT toInteger(${maxNodesPerDepth})
    `;
  },

  // ============================================
  // DYNAMIC SCHEMA DISCOVERY QUERIES
  // ============================================

  /**
   * Get all distinct node labels with counts, property keys, and property types.
   * Samples up to 10 nodes per label to collect comprehensive property info.
   */
  DISCOVER_NODE_TYPES: `
    CALL db.labels() YIELD label
    CALL {
      WITH label
      MATCH (n) WHERE label IN labels(n) AND n.projectId = $projectId
      RETURN count(n) AS nodeCount
    }
    CALL {
      WITH label
      MATCH (n) WHERE label IN labels(n) AND n.projectId = $projectId
      WITH n LIMIT 10
      UNWIND keys(n) AS key
      WITH DISTINCT key, n[key] AS val
      RETURN collect(DISTINCT key) AS properties
    }
    RETURN label, nodeCount, properties
    ORDER BY nodeCount DESC
  `,

  /**
   * Get all distinct relationship types with counts and all connection patterns
   */
  DISCOVER_RELATIONSHIP_TYPES: `
    CALL db.relationshipTypes() YIELD relationshipType
    CALL {
      WITH relationshipType
      MATCH (a)-[r]->(b) WHERE type(r) = relationshipType AND a.projectId = $projectId AND b.projectId = $projectId
      RETURN count(r) AS relCount
    }
    CALL {
      WITH relationshipType
      MATCH (a)-[r]->(b) WHERE type(r) = relationshipType AND a.projectId = $projectId AND b.projectId = $projectId
      WITH DISTINCT labels(a)[0] AS fromLabel, labels(b)[0] AS toLabel
      RETURN collect({from: fromLabel, to: toLabel}) AS connections
    }
    RETURN relationshipType, relCount, connections
    ORDER BY relCount DESC
  `,

  /**
   * Get semantic types with counts and which label they appear on
   */
  DISCOVER_SEMANTIC_TYPES: `
    MATCH (n)
    WHERE n.semanticType IS NOT NULL AND n.projectId = $projectId
    WITH n.semanticType AS semanticType, labels(n)[0] AS nodeLabel, count(*) AS count
    RETURN semanticType, nodeLabel, count
    ORDER BY count DESC
  `,

  /**
   * Get all relationship patterns between node types
   */
  DISCOVER_COMMON_PATTERNS: `
    MATCH (a)-[r]->(b)
    WHERE a.projectId = $projectId AND b.projectId = $projectId
    WITH labels(a)[0] AS fromType, type(r) AS relType, labels(b)[0] AS toType, count(*) AS count
    WHERE count > 2
    RETURN fromType, relType, toType, count
    ORDER BY count DESC
    LIMIT 50
  `,

  // ============================================
  // IMPACT ANALYSIS QUERIES
  // Reuses cross-file edge pattern to find dependents
  // ============================================

  /**
   * Get node details by ID
   */
  GET_NODE_BY_ID: `
    MATCH (n:GraphNode {id: $nodeId, projectId: $projectId})
    RETURN n.id AS id,
           n.name AS name,
           labels(n) AS labels,
           n.semanticType AS semanticType,
           n.coreType AS coreType,
           n.filePath AS filePath
  `,

  /**
   * Get impact of changing a node - finds all external nodes that depend on it
   * Based on GET_CROSS_FILE_EDGES pattern but for a single node
   */
  GET_NODE_IMPACT: `
    MATCH (target:GraphNode {id: $nodeId, projectId: $projectId})
    MATCH (dependent)-[r]->(target)
    WHERE dependent.id <> target.id AND dependent.projectId = $projectId
    RETURN DISTINCT
      dependent.id AS nodeId,
      dependent.name AS name,
      labels(dependent) AS labels,
      dependent.semanticType AS semanticType,
      dependent.coreType AS coreType,
      dependent.filePath AS filePath,
      type(r) AS relationshipType,
      coalesce(r.relationshipWeight, 0.5) AS weight
  `,

  GET_FILE_NODE_IDS: `
    MATCH (n:GraphNode {projectId: $projectId, filePath: $filePath})
    WHERE n.coreType IS NOT NULL
    RETURN n.id AS nodeId
  `,

  GET_NODES_IMPACT: `
    MATCH (target:GraphNode) WHERE target.id IN $nodeIds AND target.projectId = $projectId
    MATCH (dependent)-[r]->(target)
    WHERE dependent.projectId = $projectId AND dependent.coreType IS NOT NULL
      AND NOT dependent.id IN $nodeIds
      AND ($excludedFilePath IS NULL OR dependent.filePath IS NULL OR dependent.filePath <> $excludedFilePath)
    RETURN DISTINCT dependent.id AS nodeId, dependent.name AS name, labels(dependent) AS labels,
      dependent.semanticType AS semanticType, dependent.coreType AS coreType,
      dependent.filePath AS filePath, type(r) AS relationshipType,
      coalesce(r.relationshipWeight, 0.5) AS weight,
      target.id AS targetNodeId, target.name AS targetNodeName,
      coalesce(target.semanticType, target.coreType, labels(target)[0]) AS targetNodeType
  `,

  GET_NODES_TRANSITIVE_DEPENDENTS: (maxDepth: number = 4) => `
    MATCH (target:GraphNode) WHERE target.id IN $nodeIds AND target.projectId = $projectId
    MATCH path = (dependent)-[*2..${maxDepth}]->(target)
    WHERE dependent.projectId = $projectId AND all(n IN nodes(path) WHERE n.projectId = $projectId AND n.coreType IS NOT NULL)
      AND NOT dependent.id IN $nodeIds
      AND ($excludedFilePath IS NULL OR dependent.filePath IS NULL OR dependent.filePath <> $excludedFilePath)
    RETURN DISTINCT dependent.id AS nodeId, dependent.name AS name, labels(dependent) AS labels,
      dependent.semanticType AS semanticType, dependent.coreType AS coreType,
      dependent.filePath AS filePath, length(path) AS depth,
      [r IN relationships(path) | type(r)] AS relationshipPath
    ORDER BY depth ASC
  `,

  /**
   * Get impact of changing a file - finds all external nodes that depend on nodes in this file
   * Directly reuses GET_CROSS_FILE_EDGES pattern
   */
  GET_FILE_IMPACT: `
    MATCH (sf:SourceFile)
    WHERE sf.projectId = $projectId
      AND (sf.filePath = $filePath OR sf.filePath ENDS WITH '/' + $filePath)
    MATCH (sf)-[:CONTAINS]->(entity)
    WHERE entity:Class OR entity:Function OR entity:Interface
    WITH collect(DISTINCT entity) AS entitiesInFile, sf.filePath AS sourceFilePath
    UNWIND entitiesInFile AS n
    MATCH (dependent)-[r]->(n)
    WHERE NOT dependent IN entitiesInFile
      AND dependent.projectId = $projectId
      AND dependent.filePath <> sourceFilePath
    RETURN DISTINCT
      dependent.id AS nodeId,
      dependent.name AS name,
      labels(dependent) AS labels,
      dependent.semanticType AS semanticType,
      dependent.coreType AS coreType,
      dependent.filePath AS filePath,
      type(r) AS relationshipType,
      coalesce(r.relationshipWeight, 0.5) AS weight,
      n.id AS targetNodeId,
      n.name AS targetNodeName
  `,

  /**
   * Get transitive dependents - nodes that depend on dependents (for deeper impact)
   */
  GET_TRANSITIVE_DEPENDENTS: (maxDepth: number = 4) => `
    MATCH (target:GraphNode {id: $nodeId, projectId: $projectId})
    MATCH path = (dependent)-[*2..${maxDepth}]->(target)
    WHERE dependent.projectId = $projectId AND all(n IN nodes(path) WHERE n.projectId = $projectId)
    WITH dependent,
         length(path) AS depth,
         [r IN relationships(path) | type(r)] AS relationshipPath
    RETURN DISTINCT
      dependent.id AS nodeId,
      dependent.name AS name,
      labels(dependent) AS labels,
      dependent.semanticType AS semanticType,
      dependent.coreType AS coreType,
      dependent.filePath AS filePath,
      depth,
      relationshipPath
    ORDER BY depth ASC
  `,

  // ============================================
  // DEAD CODE DETECTION QUERIES
  // ============================================

  /**
   * Find exported classes/functions/interfaces with no incoming references from other files.
   * These are potentially dead code - exported but never imported or used.
   */
  FIND_UNREFERENCED_EXPORTS: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.isExported = true
      AND n.coreType IN ['ClassDeclaration', 'FunctionDeclaration', 'InterfaceDeclaration']
    WITH n
    OPTIONAL MATCH (other)-[r]->(n)
    WHERE other.projectId = $projectId
      AND other.filePath <> n.filePath
      AND type(r) IN ['IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'TYPED_AS', 'INJECTS', 'CALLS']
    WITH n, count(other) AS incomingCount
    WHERE incomingCount = 0
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           n.isExported AS isExported,
           'Exported but never imported or referenced' AS reason
    ORDER BY n.filePath, n.startLine
  `,

  /**
   * Find private methods with no incoming CALLS edges.
   * Private methods that are never called are likely dead code.
   */
  FIND_UNCALLED_PRIVATE_METHODS: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType = 'MethodDeclaration'
      AND n.visibility = 'private'
    WITH n
    OPTIONAL MATCH (caller)-[r:CALLS]->(n)
    WHERE caller.projectId = $projectId
    WITH n, count(caller) AS callCount
    WHERE callCount = 0
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           n.visibility AS visibility,
           'Private method never called' AS reason
    ORDER BY n.filePath, n.startLine
  `,

  /**
   * Find interfaces that are never implemented or referenced.
   * Interfaces without implementations may be dead code.
   */
  FIND_UNREFERENCED_INTERFACES: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType = 'InterfaceDeclaration'
      AND n.isExported = true
    WITH n
    OPTIONAL MATCH (other)-[r]->(n)
    WHERE other.projectId = $projectId
      AND type(r) IN ['IMPLEMENTS', 'EXTENDS', 'TYPED_AS', 'IMPORTS']
    WITH n, count(other) AS refCount
    WHERE refCount = 0
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           'Interface never implemented or referenced' AS reason
    ORDER BY n.filePath, n.startLine
  `,

  /**
   * Get all distinct semantic types for a project.
   * Used to dynamically determine framework entry points for dead code detection.
   */
  GET_PROJECT_SEMANTIC_TYPES: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.semanticType IS NOT NULL
      AND n.coreType IN ['ClassDeclaration', 'FunctionDeclaration', 'InterfaceDeclaration', 'MethodDeclaration']
    RETURN DISTINCT n.semanticType AS semanticType
  `,

  /**
   * Get framework entry points that should be excluded from dead code analysis.
   * These are nodes that may appear unused but are actually framework-managed.
   * Filters by coreType to exclude ImportDeclarations and only return actual classes/functions/interfaces.
   * Accepts $semanticTypes parameter for dynamic, per-project framework detection.
   */
  GET_FRAMEWORK_ENTRY_POINTS: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType IN ['ClassDeclaration', 'FunctionDeclaration', 'InterfaceDeclaration']
      AND (
        n.semanticType IN $semanticTypes
        OR n.filePath ENDS WITH 'main.ts'
        OR n.filePath ENDS WITH '.module.ts'
        OR n.filePath ENDS WITH '.controller.ts'
        OR n.filePath ENDS WITH 'index.ts'
      )
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath
    ORDER BY n.semanticType, n.name
  `,

  // ============================================================================
  // DUPLICATE CODE DETECTION QUERIES
  // ============================================================================

  /**
   * Find structural duplicates - nodes with identical normalizedHash.
   * Returns all nodes that share the same normalized code hash.
   * Limited to prevent memory issues on large codebases.
   */
  FIND_STRUCTURAL_DUPLICATES: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType IN $coreTypes
      AND n.normalizedHash IS NOT NULL
      AND n.normalizedHash <> ''
    WITH n.normalizedHash AS hash, collect(n) AS nodes
    WHERE size(nodes) >= 2
    UNWIND nodes AS n
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           n.normalizedHash AS normalizedHash,
           n.sourceCode AS sourceCode
    ORDER BY n.normalizedHash, n.filePath, n.startLine
    LIMIT toInteger($limit)
  `,

  /**
   * Find semantic duplicates - nodes with similar embeddings.
   * Uses vector similarity search to find semantically similar code.
   * Note: Requires the vector index 'embedded_nodes_idx' to exist.
   */
  FIND_SEMANTIC_DUPLICATES: `
    ${CYPHER_25_PREFIX}
    MATCH (n1)
    WHERE n1.projectId = $projectId
      AND n1.coreType IN $coreTypes
      AND n1.embedding IS NOT NULL
    WITH n1
    ${nearestNeighborsPerRow({
      index: VECTOR_INDEXES.embeddedNodes,
      node: 'n2',
      score: 'similarity',
      queryVector: 'n1.embedding',
      neighbors: '$vectorNeighbors',
      projectIds: '[n1.projectId]',
      outerVariables: ['n1'],
    })}
    WITH n1, n2, similarity
    WHERE n2.coreType IN $coreTypes
      AND n1.id < n2.id
      AND similarity >= $minSimilarity
      AND n1.filePath <> n2.filePath
      AND (n1.normalizedHash IS NULL OR n2.normalizedHash IS NULL OR n1.normalizedHash <> n2.normalizedHash)
    RETURN n1.id AS nodeId1,
           n1.name AS name1,
           n1.coreType AS coreType1,
           n1.semanticType AS semanticType1,
           n1.filePath AS filePath1,
           n1.startLine AS lineNumber1,
           n1.sourceCode AS sourceCode1,
           n2.id AS nodeId2,
           n2.name AS name2,
           n2.coreType AS coreType2,
           n2.semanticType AS semanticType2,
           n2.filePath AS filePath2,
           n2.startLine AS lineNumber2,
           n2.sourceCode AS sourceCode2,
           similarity
    ORDER BY similarity DESC
    LIMIT toInteger($limit)
  `,
};
