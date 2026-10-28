/**
 * Nearest-neighbour search restricted to projects, applied inside the vector index.
 *
 * Neo4j accepts only AND-joined exact values in the index filter (`IN` and `OR`
 * are rejected), so several projects take one `SEARCH` each, merged by UNWIND.
 * Callers add their own filters, joins and ranking after the returned clause.
 */

import type { Neo4jService } from './neo4j.service.js';
import type { VectorIndexDefinition } from './vector-indexes.js';
import { CYPHER_25_PREFIX, PROJECT_FILTER_PROPERTY } from './vector-indexes.js';

// Filters run after the vector search, so each project contributes more neighbours than any caller can ask for:
// a project holds a few hundred notes at most, and the cap keeps a filter from starving the result.
export const NOTE_CANDIDATES_PER_PROJECT = 300;

const UNFILTERED_INDEX_STATUS = '22ND3';

export interface NearestNeighborsOptions {
  index: VectorIndexDefinition;
  /** Variable the matched node is bound to. */
  node: string;
  /** Variable the similarity score (0..1, same scale as `queryNodes`) is bound to. */
  score: string;
  /** Cypher expression for the query vector. */
  queryVector: string;
  /** Cypher expression for the per-project neighbour count. */
  neighbors: string;
}

export interface PerRowNearestNeighborsOptions extends NearestNeighborsOptions {
  /** Cypher expression for the project ids to search. */
  projectIds: string;
  /** Variables from earlier in the query that `queryVector` or `projectIds` read. */
  outerVariables: string[];
}

const searchClause = (
  { index, node, score, queryVector, neighbors }: NearestNeighborsOptions,
  projectIds: string,
  outerVariables: string[],
): string => `UNWIND ${projectIds} AS scopeId
CALL (${['scopeId', ...outerVariables].join(', ')}) {
  MATCH (${node}:${index.label})
  SEARCH ${node} IN (
    VECTOR INDEX ${index.name} FOR ${queryVector}
    WHERE ${node}.${PROJECT_FILTER_PROPERTY} = scopeId
    LIMIT ${neighbors}
  ) SCORE AS ${score}
  RETURN ${node}, ${score}
}`;

/**
 * A complete query head that yields `node` and `score` for the projects in
 * `$projectIds`, up to `neighbors` per project. The caller appends its own clauses.
 */
export const nearestNeighborsInProjects = (options: NearestNeighborsOptions): string =>
  `${CYPHER_25_PREFIX}\n${searchClause(options, '$projectIds', [])}`;

/**
 * The same search for a query vector read from a row already matched earlier
 * in the query (for example duplicate detection). The caller starts the query
 * with `CYPHER_25_PREFIX`, because the clause cannot be first.
 */
export const nearestNeighborsPerRow = (options: PerRowNearestNeighborsOptions): string =>
  searchClause(options, options.projectIds, options.outerVariables);

export class UnfilteredVectorIndexError extends Error {
  constructor(
    readonly indexName: string,
    cause: unknown,
  ) {
    super(
      `Vector index ${indexName} does not declare ${PROJECT_FILTER_PROPERTY} as a filter property, ` +
        'so it cannot be searched by project. Restart the code-graph-context server to rebuild it.',
      { cause },
    );
    this.name = 'UnfilteredVectorIndexError';
  }
}

// A query can search two indexes (notes and their chunks); Neo4j's message names the one that is not filtered.
const indexNamedIn = (error: Error): string | undefined => /vector index `([^`]+)`/.exec(error.message)?.[1];

/** Run a query built from this module, naming the index when it is not filtered. */
export const runProjectFilteredSearch = async (
  db: Pick<Neo4jService, 'run'>,
  index: VectorIndexDefinition,
  query: string,
  params: Record<string, unknown>,
) => {
  try {
    return await db.run(query, params);
  } catch (error) {
    if (error instanceof Error && 'gqlStatus' in error && error.gqlStatus === UNFILTERED_INDEX_STATUS) {
      throw new UnfilteredVectorIndexError(indexNamedIn(error) ?? index.name, error);
    }
    throw error;
  }
};
