/**
 * The four vector indexes, defined once. Each declares `projectId` as a filter
 * property so a search can restrict to a project inside the index. Index names
 * are public: Runbench queries `session_notes_idx` and `embedded_nodes_idx` over Bolt.
 */

export interface VectorIndexDefinition {
  name: string;
  label: string;
}

export const PROJECT_FILTER_PROPERTY = 'projectId';

export const CYPHER_25_PREFIX = 'CYPHER 25';

export const VECTOR_INDEXES = {
  embeddedNodes: { name: 'embedded_nodes_idx', label: 'Embedded' },
  sessionNotes: { name: 'session_notes_idx', label: 'SessionNote' },
  sessionNoteChunks: { name: 'session_note_chunks_idx', label: 'SessionNoteChunk' },
  sessionBookmarks: { name: 'session_bookmarks_idx', label: 'SessionBookmark' },
} as const satisfies Record<string, VectorIndexDefinition>;

export const ALL_VECTOR_INDEXES: readonly VectorIndexDefinition[] = Object.values(VECTOR_INDEXES);

/** Filter properties in an index definition need the CYPHER 25 prefix; CYPHER 5 rejects `WITH`. */
export const createProjectFilteredVectorIndexQuery = (index: VectorIndexDefinition, dimensions: number): string => `
  ${CYPHER_25_PREFIX}
  CREATE VECTOR INDEX ${index.name} IF NOT EXISTS
  FOR (n:${index.label}) ON n.embedding
  WITH [n.${PROJECT_FILTER_PROPERTY}]
  OPTIONS {indexConfig: {
    \`vector.dimensions\`: ${dimensions},
    \`vector.similarity_function\`: 'cosine'
  }}
`;

/** The definition from before the filter property; the migration restores it when a filtered create fails. */
export const createUnfilteredVectorIndexQuery = (index: VectorIndexDefinition, dimensions: number): string => `
  CREATE VECTOR INDEX ${index.name} IF NOT EXISTS
  FOR (n:${index.label}) ON n.embedding
  OPTIONS {indexConfig: {
    \`vector.dimensions\`: ${dimensions},
    \`vector.similarity_function\`: 'cosine'
  }}
`;
