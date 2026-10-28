import { describe, expect, it, vi } from 'vitest';

import { QUERIES } from '../neo4j.service.js';
import {
  nearestNeighborsInProjects,
  nearestNeighborsPerRow,
  runProjectFilteredSearch,
  UnfilteredVectorIndexError,
} from '../project-vector-search.js';
import { ALL_VECTOR_INDEXES, CYPHER_25_PREFIX, VECTOR_INDEXES } from '../vector-indexes.js';

const oneSearchPerProject = (query: string) => {
  expect(query.match(/SEARCH /g)).toHaveLength(1);
  expect(query).toContain('UNWIND');
  expect(query).not.toContain('queryNodes');
  expect(query).not.toMatch(/projectId\s+(IN|OR)\b|\bOR\b.*projectId/);
};

describe('nearestNeighborsInProjects', () => {
  const query = nearestNeighborsInProjects({
    index: VECTOR_INDEXES.sessionNotes,
    node: 'note',
    score: 'relevance',
    queryVector: '$queryEmbedding',
    neighbors: '$limit',
  });

  it('starts with CYPHER 25 and searches once per project through UNWIND', () => {
    expect(query.startsWith('CYPHER 25\nUNWIND $projectIds AS scopeId\nCALL (scopeId) {')).toBe(true);
    oneSearchPerProject(query);
  });

  it('filters on projectId inside the named index and binds the caller names', () => {
    expect(query).toContain('MATCH (note:SessionNote)');
    expect(query).toContain('VECTOR INDEX session_notes_idx FOR $queryEmbedding');
    expect(query).toContain('WHERE note.projectId = scopeId');
    expect(query).toContain('LIMIT $limit');
    expect(query).toContain('SCORE AS relevance');
    expect(query).toContain('RETURN note, relevance');
  });
});

describe('nearestNeighborsPerRow', () => {
  const clause = nearestNeighborsPerRow({
    index: VECTOR_INDEXES.embeddedNodes,
    node: 'n2',
    score: 'similarity',
    queryVector: 'n1.embedding',
    neighbors: '$vectorNeighbors',
    projectIds: '[n1.projectId]',
    outerVariables: ['n1'],
  });

  it('imports the outer row and reads its vector and project', () => {
    expect(clause).not.toContain(CYPHER_25_PREFIX);
    expect(clause).toContain('UNWIND [n1.projectId] AS scopeId');
    expect(clause).toContain('CALL (scopeId, n1) {');
    expect(clause).toContain('FOR n1.embedding');
    oneSearchPerProject(clause);
  });
});

describe('FIND_SEMANTIC_DUPLICATES', () => {
  const query = QUERIES.FIND_SEMANTIC_DUPLICATES;

  it('is a CYPHER 25 per-row filtered search with the same output columns', () => {
    expect(query.trimStart().startsWith('CYPHER 25')).toBe(true);
    oneSearchPerProject(query);
    expect(query).toContain('VECTOR INDEX embedded_nodes_idx FOR n1.embedding');
    expect(query).toContain('LIMIT $vectorNeighbors');
    expect(query).toMatch(/WITH n1, n2, similarity\s+WHERE n2\.coreType IN \$coreTypes/);
    expect(query).toContain('n1.id AS nodeId1');
    expect(query).toContain('n2.id AS nodeId2');
    expect(query).toContain('n2.sourceCode AS sourceCode2');
    expect(query).toContain('           similarity\n');
  });
});

describe('vector index creation', () => {
  it.each([
    ['CREATE_EMBEDDED_VECTOR_INDEX', 'embedded_nodes_idx', 'Embedded'],
    ['CREATE_SESSION_NOTES_VECTOR_INDEX', 'session_notes_idx', 'SessionNote'],
    ['CREATE_SESSION_NOTE_CHUNKS_VECTOR_INDEX', 'session_note_chunks_idx', 'SessionNoteChunk'],
    ['CREATE_SESSION_BOOKMARKS_VECTOR_INDEX', 'session_bookmarks_idx', 'SessionBookmark'],
  ] as const)('%s declares projectId as a filter property', (entry, name, label) => {
    const statement = QUERIES[entry](768);
    expect(statement.trimStart().startsWith('CYPHER 25')).toBe(true);
    expect(statement).toContain(`CREATE VECTOR INDEX ${name} IF NOT EXISTS`);
    expect(statement).toContain(`FOR (n:${label}) ON n.embedding`);
    expect(statement).toContain('WITH [n.projectId]');
    expect(statement).toContain('`vector.dimensions`: 768');
    expect(statement).toContain("`vector.similarity_function`: 'cosine'");
  });

  it('keeps the four index names Runbench and the tools rely on', () => {
    expect(ALL_VECTOR_INDEXES.map((index) => index.name)).toEqual([
      'embedded_nodes_idx',
      'session_notes_idx',
      'session_note_chunks_idx',
      'session_bookmarks_idx',
    ]);
  });
});

describe('runProjectFilteredSearch', () => {
  const unfiltered = Object.assign(new Error('22ND3: wrong property for vector search with filters'), {
    gqlStatus: '22ND3',
  });

  it('names the index and says a restart rebuilds it when the index lacks projectId', async () => {
    const db = { run: vi.fn().mockRejectedValue(unfiltered) };
    const failure = runProjectFilteredSearch(db, VECTOR_INDEXES.embeddedNodes, 'q', {});
    await expect(failure).rejects.toBeInstanceOf(UnfilteredVectorIndexError);
    await expect(failure).rejects.toThrow(/embedded_nodes_idx.*Restart/);
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('names the index Neo4j reports when a query searches two indexes', async () => {
    // Message captured from Neo4j 2026.02.2 for a filtered SEARCH on an index without the filter property.
    const chunkIndexUnfiltered = Object.assign(
      new Error(
        '22ND3: data exception - wrong property for vector search with filters. The property `projectId` is not an ' +
          'additional property for vector search with filters on the vector index `session_note_chunks_idx`.',
      ),
      { gqlStatus: '22ND3' },
    );
    const db = { run: vi.fn().mockRejectedValue(chunkIndexUnfiltered) };
    const failure = runProjectFilteredSearch(db, VECTOR_INDEXES.sessionNotes, 'q', {});
    await expect(failure).rejects.toMatchObject({ indexName: 'session_note_chunks_idx' });
  });

  it('rethrows other errors unchanged', async () => {
    const other = new Error('Connection refused');
    const db = { run: vi.fn().mockRejectedValue(other) };
    await expect(runProjectFilteredSearch(db, VECTOR_INDEXES.embeddedNodes, 'q', {})).rejects.toBe(other);
  });

  it('returns the rows on success', async () => {
    const rows = [{ id: 'a' }];
    const db = { run: vi.fn().mockResolvedValue(rows) };
    expect(await runProjectFilteredSearch(db, VECTOR_INDEXES.embeddedNodes, 'q', { projectIds: ['p'] })).toBe(rows);
    expect(db.run).toHaveBeenCalledWith('q', { projectIds: ['p'] });
  });
});
