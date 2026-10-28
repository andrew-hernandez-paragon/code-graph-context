/**
 * Service Initialization
 * Handles initialization of external services like Neo4j schema and OpenAI assistant
 */

import fs from 'fs/promises';
import { join } from 'path';

import {
  EmbeddingsService,
  isOpenAIEnabled,
  isOpenAIAvailable,
  isOpenAIRequested,
  getEmbeddingDimensions,
  getEmbeddingModel,
} from '../core/embeddings/embeddings.service.js';
import { ProjectService } from '../core/projects/index.js';
import { toNumber } from '../core/utils/shared-utils.js';
import { describeOldNeo4j, readNeo4jVersion, supportsProjectFilteredSearch } from '../storage/neo4j/neo4j-version.js';
import { Neo4jService, QUERIES } from '../storage/neo4j/neo4j.service.js';
import { rebuildVectorIndexesWithProjectFilter } from '../storage/neo4j/project-filter-index-migration.js';

import { FILE_PATHS, LOG_CONFIG } from './constants.js';
import { STARTUP_RETRY_INTERVAL_MS, createNeo4jStartupService, retryInBackground } from './neo4j-startup.js';
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
      message: `[code-graph-context] Embedding provider: ${provider}, model: ${getEmbeddingModel()} (${dims} dimensions)`,
    }),
  );
  await debugLog('Embedding configuration', { provider, model: getEmbeddingModel(), dimensions: dims });

  if (isOpenAIRequested() && !isOpenAIAvailable()) {
    console.error(
      JSON.stringify({
        level: 'warn',
        message: '[code-graph-context] OpenAI embeddings requested without OPENAI_API_KEY. Using local embeddings.',
      }),
    );
    await debugLog('Configuration warning', { warning: 'OpenAI embeddings requested without a key; using local' });
  }

  if (process.env.OPENAI_EMBEDDINGS_ENABLED === undefined && process.env.OPENAI_ENABLED !== undefined) {
    console.error('[code-graph-context] OPENAI_ENABLED is deprecated. Use OPENAI_EMBEDDINGS_ENABLED instead.');
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

const logInfo = (message: string): void => {
  console.error(JSON.stringify({ level: 'info', message: `[code-graph-context] ${message}` }));
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const logError = (message: string): void => {
  console.error(JSON.stringify({ level: 'error', message: `[code-graph-context] ${message}` }));
};

/**
 * Ensure Neo4j answers on Bolt, starting the recorded provider if it does not
 */
const ensureNeo4j = async (): Promise<void> => {
  const action = await createNeo4jStartupService().ensureRunning();

  if (action === 'docker-created') logInfo('Neo4j container created and started');
  else if (action === 'docker-started') logInfo('Neo4j container started');
  else if (action === 'native-started') logInfo('Native Neo4j service started');

  await debugLog('Neo4j ready', { action });
};

/**
 * Keep trying the Neo4j step after a failed start, then run the steps that need it.
 * Not awaited by the caller: the MCP server is already serving.
 */
const retryNeo4jStartup = async (): Promise<void> => {
  const recovered = await retryInBackground({
    attempt: ensureNeo4j,
    onAttempt: (attempt, maxAttempts) =>
      logInfo(
        `Retrying Neo4j startup (attempt ${attempt} of ${maxAttempts}, every ${STARTUP_RETRY_INTERVAL_MS / 1000}s)`,
      ),
    onFailure: (attempt, error) => logError(`Neo4j startup attempt ${attempt} failed: ${describeError(error)}`),
  });
  if (!recovered) {
    logError('Neo4j startup retries exhausted. Start Neo4j or run: code-graph-context init');
    return;
  }
  await initializeNeo4jDependentServices();
};

/**
 * Initialize all external services required by the MCP server
 */
export const initializeServices = async (): Promise<void> => {
  // Check for missing configuration (non-fatal warnings)
  await checkConfiguration();

  try {
    await ensureNeo4j();
  } catch (error) {
    logError(describeError(error));
    void retryNeo4jStartup().catch((retryError) =>
      logError(`Service initialization failed: ${describeError(retryError)}`),
    );
    return;
  }

  await initializeNeo4jDependentServices();
};

const initializeNeo4jDependentServices = async (): Promise<void> => {
  // Initialize services sequentially - schema must be written before NL service reads it
  await initializeNeo4jSchema();

  // Idempotent: sets Project.kind on nodes written by servers that predate it.
  await backfillProjectKinds();

  // Before the steps below write or index vectors, so none of them recreates an unfiltered index.
  await rebuildVectorIndexes();

  // Idempotent: a second start finds no notes left to migrate.
  await migrateSessionNoteProperties();

  // Idempotent, resumable across restarts, and non-fatal when embeddings are unavailable.
  await backfillBookmarkEmbeddings();

  // Idempotent creation of the BM25 index behind hybrid code search (0014).
  // Runs every startup so an existing graph gains the lexical channel on
  // upgrade; Neo4j backfills it from the :Embedded nodes already stored, so
  // no reparse and no re-embed is needed.
  await ensureCodeFulltextIndex();

  // Graphs parsed before these indexes existed only get them here, not from a reparse.
  await ensureCodeNodeLookupIndexes();

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

const rebuildVectorIndexes = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();
    try {
      const version = await readNeo4jVersion(neo4jService);
      if (version !== null && !supportsProjectFilteredSearch(version)) {
        logError(describeOldNeo4j(version));
        return;
      }
      const results = await rebuildVectorIndexesWithProjectFilter(neo4jService, getEmbeddingDimensions());
      for (const { indexName, outcome, reason } of results) {
        if (outcome === 'failed') {
          logError(
            `Vector index ${indexName} could not be rebuilt with the projectId filter: ${reason}. Searching it will fail until the index is online.`,
          );
        } else {
          logInfo(`Vector index ${indexName}: ${outcome}`);
        }
      }
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    logError(
      `Vector index rebuild failed: ${describeError(error)}. Searching an index that lacks the projectId filter will fail until it is online.`,
    );
  }
};

const backfillProjectKinds = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();
    try {
      const backfilled = await new ProjectService(neo4jService).backfillKinds();
      if (backfilled > 0) {
        logInfo(`Set the kind of ${backfilled} Project node(s)`);
      }
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    // Reads fall back to the same rule through projectKindCypher, so a failed backfill loses nothing.
    logError(`Project kind backfill skipped: ${describeError(error)}`);
  }
};

/**
 * Backfill SessionNote properties added after the first notes were written:
 *   - aboutNodeIds: recovered from existing :ABOUT edges so the post-parse
 *     edge recovery can re-link after a reparse.
 *   - lastValidated: defaults to createdAt for old notes; subsequent saves /
 *     updates bump it to timestamp().
 *
 * supersededBy is not matched: Neo4j stores no property for null, so every
 * current note lacks it and the match would select every note on every start.
 *
 * Idempotent via coalesce: only writes properties that are currently NULL.
 * Subsequent startups touch zero rows once all notes are migrated.
 */
export const MIGRATE_SESSION_NOTE_PROPERTIES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.aboutNodeIds IS NULL
     OR n.lastValidated IS NULL
  OPTIONAL MATCH (n)-[:ABOUT]->(target)
  WITH n, collect(DISTINCT target.id) AS resolvedAboutNodeIds
  SET n.aboutNodeIds  = coalesce(n.aboutNodeIds, resolvedAboutNodeIds),
      n.lastValidated = coalesce(n.lastValidated, n.createdAt)
  RETURN count(n) AS migrated
`;

const migrateSessionNoteProperties = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();
    try {
      const result = await neo4jService.run(MIGRATE_SESSION_NOTE_PROPERTIES_QUERY, {});
      const migrated = result[0]?.migrated;
      const count = toNumber(migrated);
      if (count > 0) {
        logInfo(`Migrated ${count} SessionNote(s) to the current schema`);
      }
      await debugLog('SessionNote property migration complete', { migrated: count });
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    // Migration is non-fatal, log but don't block startup. New notes will
    // populate the new properties; old notes can be re-migrated next startup.
    await debugLog('SessionNote property migration failed (non-fatal)', { error: String(error) });
    logError(`SessionNote migration skipped: ${describeError(error)}`);
  }
};

/**
 * Create the code fulltext index if it is not already there (0014).
 *
 * Separate from GraphGeneratorHandler.ensureIndexes, which only runs on parse:
 * an existing user upgrading gets the lexical channel on the next server start
 * without having to reparse anything.
 *
 * Failure is non-fatal. searchCodeLexical returns [] when the index is missing,
 * so search falls back to vector-only rather than erroring.
 */
const ensureCodeFulltextIndex = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();
    try {
      await neo4jService.run(QUERIES.CREATE_EMBEDDED_FULLTEXT_INDEX);
      await debugLog('Code fulltext index ensured');
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    await debugLog('Failed to ensure code fulltext index', error);
  }
};

const ensureCodeNodeLookupIndexes = async (): Promise<void> => {
  try {
    const neo4jService = new Neo4jService();
    try {
      await neo4jService.run(QUERIES.CREATE_PROJECT_ID_INDEX_GRAPHNODE);
      await neo4jService.run(QUERIES.CREATE_PROJECT_FILEPATH_INDEX_GRAPHNODE);
      await neo4jService.run(QUERIES.CREATE_PROJECT_NAME_INDEX_GRAPHNODE);
      await debugLog('Code node lookup indexes ensured');
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    await debugLog('Failed to ensure code node lookup indexes', error);
  }
};

/**
 * Backfill embeddings for SessionBookmark nodes that don't have one yet.
 * Cypher can't call the embedding service, so this is
 * application-side code, paginated, idempotent, resumable across restarts.
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
              // Empty bookmark, set a placeholder zero-vector to avoid re-trying forever.
              // Better to skip via a sentinel; for now mark with a dummy embedding so the
              // WHERE n.embedding IS NULL filter excludes it.
              continue;
            }
            const embedding = await embeddingsService.embedText(text);
            await neo4jService.run(QUERIES.SET_BOOKMARK_EMBEDDING_QUERY, {
              bookmarkId: row.id,
              projectId: row.projectId,
              embedding,
              embeddingProvider: embeddingsService.provider,
              embeddingModel: embeddingsService.model,
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
        logInfo(`Backfilled embeddings for ${totalMigrated} SessionBookmark(s)`);
      }
      await debugLog('SessionBookmark embedding backfill complete', { migrated: totalMigrated });
    } finally {
      await neo4jService.close();
    }
  } catch (error) {
    await debugLog('SessionBookmark embedding backfill failed (non-fatal)', { error: String(error) });
    logError(`Bookmark embedding backfill skipped: ${describeError(error)}`);
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

    // Find the most recently updated codebase to scope discovery queries
    const codebases = await new ProjectService(neo4jService).list(['codebase']);
    const projectId = codebases.length > 0 ? codebases[0].projectId : null;

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
