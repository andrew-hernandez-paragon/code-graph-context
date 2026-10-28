/**
 * Rebuilds vector indexes that predate the `projectId` filter property.
 * Dropping an index makes vector search fail until it is recreated, so the
 * name says what it does; the caller decides when to run it.
 */

import neo4j from 'neo4j-driver';

import type { Neo4jService } from './neo4j.service.js';
import {
  ALL_VECTOR_INDEXES,
  PROJECT_FILTER_PROPERTY,
  createProjectFilteredVectorIndexQuery,
  createUnfilteredVectorIndexQuery,
  type VectorIndexDefinition,
} from './vector-indexes.js';

/** Build times measured: 2 s for 1,040 notes, 12.5 s for 98k code nodes. */
export const INDEX_ONLINE_TIMEOUT_SECONDS = 300;

const DIMENSIONS_OPTION = 'vector.dimensions';
const MAX_BUILD_ATTEMPTS = 2;

export type VectorIndexRebuildOutcome = 'created' | 'rebuilt' | 'unchanged' | 'failed';

export interface VectorIndexRebuildResult {
  indexName: string;
  outcome: VectorIndexRebuildOutcome;
  /** Why the index is `failed`. */
  reason?: string;
}

interface ShownVectorIndex {
  name: string;
  properties: string[];
  state: string;
  options: { indexConfig?: Record<string, unknown> };
}

const showVectorIndexes = async (db: Pick<Neo4jService, 'run'>): Promise<ShownVectorIndex[]> =>
  (await db.run('SHOW VECTOR INDEXES YIELD name, properties, state, options')) as unknown as ShownVectorIndex[];

const declaresProjectFilter = (shown: ShownVectorIndex): boolean => shown.properties.includes(PROJECT_FILTER_PROPERTY);

const readDimensions = (shown: ShownVectorIndex): number | null => {
  const value = shown.options.indexConfig?.[DIMENSIONS_OPTION];
  if (neo4j.isInt(value)) return value.toNumber();
  return typeof value === 'number' ? value : null;
};

const isOnlineAndFiltered = async (db: Pick<Neo4jService, 'run'>, index: VectorIndexDefinition): Promise<boolean> => {
  const shown = (await showVectorIndexes(db)).find((candidate) => candidate.name === index.name);
  return shown !== undefined && shown.state === 'ONLINE' && declaresProjectFilter(shown);
};

/**
 * Create the filtered index and confirm it. Servers still on the old
 * definition run `CREATE ... IF NOT EXISTS` on every save and parse, so one can
 * recreate an unfiltered index first and turn this create into a no-op; the
 * confirmation catches that and the loop drops and creates once more.
 */
const createFilteredIndex = async (
  db: Pick<Neo4jService, 'run'>,
  index: VectorIndexDefinition,
  dimensions: number,
): Promise<boolean> => {
  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    if (attempt > 1) await db.run(`DROP INDEX ${index.name} IF EXISTS`);
    await db.run(createProjectFilteredVectorIndexQuery(index, dimensions));
    await db.run('CALL db.awaitIndex($name, $timeoutSeconds)', {
      name: index.name,
      timeoutSeconds: INDEX_ONLINE_TIMEOUT_SECONDS,
    });
    if (await isOnlineAndFiltered(db, index)) return true;
  }
  return false;
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The drop already happened, so put back what was there instead of leaving the store without the index. */
const restoreOriginalIndex = async (
  db: Pick<Neo4jService, 'run'>,
  index: VectorIndexDefinition,
  dimensions: number,
  createError: unknown,
): Promise<VectorIndexRebuildResult> => {
  try {
    await db.run(createUnfilteredVectorIndexQuery(index, dimensions));
  } catch (restoreError) {
    return {
      indexName: index.name,
      outcome: 'failed',
      reason: `${describeError(createError)}; restoring the unfiltered index also failed: ${describeError(restoreError)}. The index is missing.`,
    };
  }
  return {
    indexName: index.name,
    outcome: 'failed',
    reason: `${describeError(createError)}; the unfiltered index was restored`,
  };
};

const rebuildIndex = async (
  db: Pick<Neo4jService, 'run'>,
  index: VectorIndexDefinition,
  shown: ShownVectorIndex | undefined,
  configuredDimensions: number,
): Promise<VectorIndexRebuildResult> => {
  if (shown !== undefined && declaresProjectFilter(shown)) {
    return { indexName: index.name, outcome: 'unchanged' };
  }

  // Stored vectors were written at the existing index's size, which may differ from the configured model's.
  const dimensions = shown === undefined ? configuredDimensions : readDimensions(shown);
  if (dimensions === null) {
    return { indexName: index.name, outcome: 'failed', reason: `existing index has no ${DIMENSIONS_OPTION}` };
  }

  if (shown !== undefined) await db.run(`DROP INDEX ${index.name} IF EXISTS`);
  let filtered: boolean;
  try {
    filtered = await createFilteredIndex(db, index, dimensions);
  } catch (createError) {
    return shown === undefined
      ? { indexName: index.name, outcome: 'failed', reason: describeError(createError) }
      : await restoreOriginalIndex(db, index, dimensions, createError);
  }
  if (!filtered) {
    return {
      indexName: index.name,
      outcome: 'failed',
      reason: `still not ONLINE with ${PROJECT_FILTER_PROPERTY} after ${MAX_BUILD_ATTEMPTS} attempts`,
    };
  }
  return { indexName: index.name, outcome: shown === undefined ? 'created' : 'rebuilt' };
};

export const rebuildVectorIndexesWithProjectFilter = async (
  db: Pick<Neo4jService, 'run'>,
  configuredDimensions: number,
): Promise<VectorIndexRebuildResult[]> => {
  const existing = await showVectorIndexes(db);
  const results: VectorIndexRebuildResult[] = [];
  for (const index of ALL_VECTOR_INDEXES) {
    const shown = existing.find((candidate) => candidate.name === index.name);
    try {
      results.push(await rebuildIndex(db, index, shown, configuredDimensions));
    } catch (error) {
      results.push({
        indexName: index.name,
        outcome: 'failed',
        reason: describeError(error),
      });
    }
  }
  return results;
};
