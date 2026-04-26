/**
 * Service Initialization
 * Handles initialization of external services like Neo4j schema and OpenAI assistant
 */

import fs from 'fs/promises';
import { join } from 'path';

import { ensureNeo4jRunning, isDockerInstalled, isDockerRunning } from '../cli/neo4j-docker.js';
import {
  EmbeddingsService,
  isOpenAIEnabled,
  isOpenAIAvailable,
  getEmbeddingDimensions,
} from '../core/embeddings/embeddings.service.js';
import { LIST_PROJECTS_QUERY } from '../core/utils/project-id.js';
import { Neo4jService, QUERIES } from '../storage/neo4j/neo4j.service.js';

import { FILE_PATHS, LOG_CONFIG } from './constants.js';
import { initializeNaturalLanguageService } from './tools/natural-language-to-cypher.tool.js';
import { debugLog } from './utils.js';

/**
 * Log startup warnings for missing configuration
 */
const checkConfiguration = async (): Promise<void> => {
  const openai = isOpenAIEnabled();
  const dims = getEmbeddingDimensions();
  const provider = openai ? 'openai' : 'local';

  console.error(
    JSON.stringify({
      level: 'info',
      message: `[code-graph-context] Embedding provider: ${provider} (${dims} dimensions)`,
    }),
  );
  await debugLog('Embedding configuration', { provider, dimensions: dims });

  if (openai && !isOpenAIAvailable()) {
    console.error(
      JSON.stringify({
        level: 'warn',
        message:
          '[code-graph-context] OPENAI_EMBEDDINGS_ENABLED=true but OPENAI_API_KEY not set. Embedding calls will fail.',
      }),
    );
    await debugLog('Configuration warning', { warning: 'OPENAI_EMBEDDINGS_ENABLED=true but OPENAI_API_KEY not set' });
  }

  if (!openai) {
    console.error(
      JSON.stringify({
        level: 'info',
        message: '[code-graph-context] Using local embeddings (Python sidecar). Starts on first embedding request.',
      }),
    );
  }

  if (!isOpenAIAvailable()) {
    console.error(
      JSON.stringify({
        level: 'info',
        message: '[code-graph-context] natural_language_to_cypher unavailable: OPENAI_API_KEY not set.',
      }),
    );
  }
};

/**
 * Ensure Neo4j is running - auto-start if Docker available, fail if not
 */
const ensureNeo4j = async (): Promise<void> => {
  // Check if Docker is available
  if (!isDockerInstalled()) {
    const msg = 'Docker not installed. Install Docker or run: code-graph-context init';
    console.error(JSON.stringify({ level: 'error', message: `[code-graph-context] ${msg}` }));
    throw new Error(msg);
  }

  if (!isDockerRunning()) {
    const msg = 'Docker not running. Start Docker or run: code-graph-context init';
    console.error(JSON.stringify({ level: 'error', message: `[code-graph-context] ${msg}` }));
    throw new Error(msg);
  }

  const result = await ensureNeo4jRunning();

  if (!result.success) {
    const msg = `Neo4j failed to start: ${result.error}. Run: code-graph-context init`;
    console.error(JSON.stringify({ level: 'error', message: `[code-graph-context] ${msg}` }));
    throw new Error(msg);
  }

  if (result.action === 'created') {
    console.error(
      JSON.stringify({
        level: 'info',
        message: '[code-graph-context] Neo4j container created and started',
      }),
    );
  } else if (result.action === 'started') {
    console.error(
      JSON.stringify({
        level: 'info',
        message: '[code-graph-context] Neo4j container started',
      }),
    );
  }

  await debugLog('Neo4j ready', result);
};

/**
 * Initialize all external services required by the MCP server
 */
export const initializeServices = async (): Promise<void> => {
  // Check for missing configuration (non-fatal warnings)
  await checkConfiguration();

  // Ensure Neo4j is running (fatal if not)
  await ensureNeo4j();

  // Initialize services sequentially - schema must be written before NL service reads it
  await initializeNeo4jSchema();

  // Idempotent backfill of new SessionNote properties added in Phase 1.3.
  // Runs every startup; subsequent runs are no-ops once all notes are migrated.
  await migrateSessionNoteProperties();

  // Idempotent backfill of SessionBookmark embeddings (Phase 1.5b).
  // Paginated; resumable across restarts; non-fatal if embeddings unavailable.
  await backfillBookmarkEmbeddings();

  if (isOpenAIAvailable()) {
    await initializeNaturalLanguageService();
  } else {
    console.error(
      JSON.stringify({
        level: 'info',
        message: '[code-graph-context] natural_language_to_cypher unavailable: OPENAI_API_KEY not set',
      }),
    );
  }
};

/**
 * Backfill SessionNote properties added in Phase 1.3:
 *   - aboutNodeIds  — recovered from existing :ABOUT edges so the post-parse
 *                     edge recovery (Phase 1.4) can re-link after a reparse.
 *   - lastValidated — defaults to createdAt for old notes; subsequent saves /
 *                     updates bump it to timestamp().
 *   - supersededBy  — defaults to null. Single signal for "is this current?";
 *                     non-null filters the note out of default recall results.
 *
 * Idempotent via coalesce — only writes properties that are currently NULL.
 * Subsequent startups touch zero rows once all notes are migrated.
 */
const migrateSessionNoteProperties = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();
    try {
      const result = await neo4jService.run(
        `
          MATCH (n:SessionNote)
          WHERE n.aboutNodeIds IS NULL
             OR n.lastValidated IS NULL
             OR n.supersededBy IS NULL
          OPTIONAL MATCH (n)-[:ABOUT]->(target)
          WITH n, collect(DISTINCT target.id) AS resolvedAboutNodeIds
          SET n.aboutNodeIds  = coalesce(n.aboutNodeIds, resolvedAboutNodeIds),
              n.lastValidated = coalesce(n.lastValidated, n.createdAt),
              n.supersededBy  = coalesce(n.supersededBy, null)
          RETURN count(n) AS migrated
        `,
        {},
      );
      const migrated = result[0]?.migrated;
      const count =
        typeof migrated === 'object' && migrated && 'toNumber' in migrated
          ? (migrated as any).toNumber()
          : (migrated ?? 0);
      if (count > 0) {
        console.error(
          JSON.stringify({
            level: 'info',
            message: `[code-graph-context] Migrated ${count} SessionNote(s) to Phase 1.3 schema`,
          }),
        );
      }
      await debugLog('SessionNote property migration complete', { migrated: count });
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    // Migration is non-fatal — log but don't block startup. New notes will
    // populate the new properties; old notes can be re-migrated next startup.
    await debugLog('SessionNote property migration failed (non-fatal)', { error: String(error) });
    console.error(
      JSON.stringify({
        level: 'warn',
        message: `[code-graph-context] SessionNote migration skipped: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
};

/**
 * Backfill embeddings for SessionBookmark nodes that don't have one yet
 * (Phase 1.5b). Cypher can't call the embedding service, so this is
 * application-side code — paginated, idempotent, resumable across restarts.
 *
 * Runs at MCP startup. On the first startup after upgrade, walks the bookmark
 * corpus 100 at a time and embeds each. Subsequent startups touch zero rows.
 *
 * Failure is non-fatal: a missing index, an unavailable embedding service,
 * or a transient OpenAI error stops the backfill but does not block startup.
 * New saves will populate `embedding` directly via the create path.
 */
const backfillBookmarkEmbeddings = async (): Promise<void> => {
  const BATCH_SIZE = 100;
  let totalMigrated = 0;
  try {
    const neo4jService = new Neo4jService();
    try {
      // Ensure the index exists before populating embeddings.
      await neo4jService.run(QUERIES.CREATE_SESSION_BOOKMARKS_VECTOR_INDEX(getEmbeddingDimensions()));

      const embeddingsService = new EmbeddingsService();

      // Loop until no more bookmarks are missing embeddings.
      // Each iteration is its own transaction; safe to interrupt.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rows = await neo4jService.run(
          `
            MATCH (b:SessionBookmark)
            WHERE b.embedding IS NULL
            RETURN b.id AS id,
                   b.projectId AS projectId,
                   b.taskContext AS taskContext,
                   b.summary AS summary,
                   b.findings AS findings,
                   b.nextSteps AS nextSteps
            LIMIT toInteger($batchSize)
          `,
          { batchSize: BATCH_SIZE },
        );

        if (rows.length === 0) break;

        for (const row of rows) {
          try {
            const text = [row.taskContext, row.summary, row.findings, row.nextSteps]
              .filter((s: any) => typeof s === 'string' && s.length > 0)
              .join('\n\n');
            if (text.length === 0) {
              // Empty bookmark — set a placeholder zero-vector to avoid re-trying forever.
              // Better to skip via a sentinel; for now mark with a dummy embedding so the
              // WHERE n.embedding IS NULL filter excludes it.
              continue;
            }
            const embedding = await embeddingsService.embedText(text);
            await neo4jService.run(QUERIES.SET_BOOKMARK_EMBEDDING_QUERY, {
              bookmarkId: row.id,
              projectId: row.projectId,
              embedding,
            });
            totalMigrated += 1;
          } catch (rowErr) {
            await debugLog('Bookmark backfill: embed failed for one row (non-fatal)', {
              bookmarkId: row.id,
              error: String(rowErr),
            });
          }
        }

        // Defensive: if we couldn't embed any in this batch, exit to avoid infinite loop.
        if (rows.length < BATCH_SIZE) break;
      }

      if (totalMigrated > 0) {
        console.error(
          JSON.stringify({
            level: 'info',
            message: `[code-graph-context] Backfilled embeddings for ${totalMigrated} SessionBookmark(s)`,
          }),
        );
      }
      await debugLog('SessionBookmark embedding backfill complete', { migrated: totalMigrated });
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    await debugLog('SessionBookmark embedding backfill failed (non-fatal)', { error: String(error) });
    console.error(
      JSON.stringify({
        level: 'warn',
        message: `[code-graph-context] Bookmark embedding backfill skipped: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
};

/**
 * Dynamically discover schema from the actual graph contents.
 * This is framework-agnostic - it discovers what's actually in the graph.
 */
const discoverSchemaFromGraph = async (neo4jService: Neo4jService, projectId: string) => {
  try {
    // Discover actual node types, relationships, and patterns from the graph
    const [nodeTypes, relationshipTypes, semanticTypes, commonPatterns] = await Promise.all([
      neo4jService.run(QUERIES.DISCOVER_NODE_TYPES, { projectId }),
      neo4jService.run(QUERIES.DISCOVER_RELATIONSHIP_TYPES, { projectId }),
      neo4jService.run(QUERIES.DISCOVER_SEMANTIC_TYPES, { projectId }),
      neo4jService.run(QUERIES.DISCOVER_COMMON_PATTERNS, { projectId }),
    ]);

    return {
      nodeTypes: nodeTypes.map((r: any) => ({
        label: r.label,
        count: typeof r.nodeCount === 'object' ? r.nodeCount.toNumber() : r.nodeCount,
        properties: r.properties ?? [],
      })),
      relationshipTypes: relationshipTypes.map((r: any) => ({
        type: r.relationshipType,
        count: typeof r.relCount === 'object' ? r.relCount.toNumber() : r.relCount,
        connections: r.connections ?? [],
      })),
      semanticTypes: semanticTypes.map((r: any) => ({
        type: r.semanticType,
        label: r.nodeLabel,
        count: typeof r.count === 'object' ? r.count.toNumber() : r.count,
      })),
      commonPatterns: commonPatterns.map((r: any) => ({
        from: r.fromType,
        relationship: r.relType,
        to: r.toType,
        count: typeof r.count === 'object' ? r.count.toNumber() : r.count,
      })),
    };
  } catch (error) {
    await debugLog('Failed to discover schema from graph', error);
    return null;
  }
};

/**
 * Initialize Neo4j schema by fetching from APOC and discovering actual graph structure
 */
const initializeNeo4jSchema = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();

    // Find the most recently updated project to scope discovery queries
    const projects = await neo4jService.run(LIST_PROJECTS_QUERY, {});
    const projectId = projects.length > 0 ? (projects[0].projectId as string) : null;

    // Dynamically discover what's actually in the graph
    const schema = projectId ? await discoverSchemaFromGraph(neo4jService, projectId) : null;

    const schemaPath = join(process.cwd(), FILE_PATHS.schemaOutput);
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, LOG_CONFIG.jsonIndentation));

    await debugLog('Neo4j schema cached successfully', { schemaPath });
  } catch (error) {
    await debugLog('Failed to initialize Neo4j schema', error);
    // Don't throw - service can still function without cached schema
  }
};
