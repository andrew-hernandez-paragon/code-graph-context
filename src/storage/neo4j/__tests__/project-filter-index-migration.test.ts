import neo4j from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import {
  INDEX_ONLINE_TIMEOUT_SECONDS,
  rebuildVectorIndexesWithProjectFilter,
} from '../project-filter-index-migration.js';

type Shown = { name: string; properties: string[]; state: string; options: { indexConfig: Record<string, unknown> } };

const shown = (name: string, properties: string[], dimensions = 768, state = 'ONLINE'): Shown => ({
  name,
  properties,
  state,
  options: { indexConfig: { 'vector.dimensions': dimensions } },
});

const FILTERED = ['embedding', 'projectId'];
const NAMES = ['embedded_nodes_idx', 'session_notes_idx', 'session_note_chunks_idx', 'session_bookmarks_idx'];

/** Serves queued SHOW results in order, repeating the last one; every other statement is recorded. */
const makeDb = (...showResults: Shown[][]) => {
  const statements: string[] = [];
  let shows = 0;
  const run = vi.fn(async (query: string) => {
    if (query.startsWith('SHOW VECTOR INDEXES')) return showResults[Math.min(shows++, showResults.length - 1)];
    statements.push(query.trim().split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' '));
    return [];
  });
  return { run, statements };
};

const allFiltered = NAMES.map((name) => shown(name, FILTERED));

describe('rebuildVectorIndexesWithProjectFilter', () => {
  it('leaves already filtered indexes alone', async () => {
    const db = makeDb(allFiltered);
    const results = await rebuildVectorIndexesWithProjectFilter(db, 768);
    expect(results).toEqual(NAMES.map((indexName) => ({ indexName, outcome: 'unchanged' })));
    expect(db.statements).toEqual([]);
  });

  it('creates a missing index with the configured dimensions and waits for it', async () => {
    const present = allFiltered.filter((index) => index.name !== 'session_notes_idx');
    const db = makeDb(present, [...present, shown('session_notes_idx', FILTERED, 1024)]);
    const results = await rebuildVectorIndexesWithProjectFilter(db, 1024);

    expect(results.find((r) => r.indexName === 'session_notes_idx')).toEqual({
      indexName: 'session_notes_idx',
      outcome: 'created',
    });
    expect(db.statements).toEqual([
      'CYPHER 25 CREATE VECTOR INDEX session_notes_idx IF NOT EXISTS',
      'CALL db.awaitIndex($name, $timeoutSeconds)',
    ]);
    expect(db.run).toHaveBeenCalledWith('CALL db.awaitIndex($name, $timeoutSeconds)', {
      name: 'session_notes_idx',
      timeoutSeconds: INDEX_ONLINE_TIMEOUT_SECONDS,
    });
    expect(db.run.mock.calls.map(([query]) => query).join()).toContain('`vector.dimensions`: 1024');
  });

  it('drops an unfiltered index and recreates it at the dimensions it already had, not the configured ones', async () => {
    const before = allFiltered.map((index) =>
      index.name === 'embedded_nodes_idx' ? shown(index.name, ['embedding'], 768) : index,
    );
    const db = makeDb(before, allFiltered);
    const results = await rebuildVectorIndexesWithProjectFilter(db, 1024);

    expect(results.find((r) => r.indexName === 'embedded_nodes_idx')?.outcome).toBe('rebuilt');
    expect(db.statements[0]).toBe('DROP INDEX embedded_nodes_idx IF EXISTS');
    const create = db.run.mock.calls.map(([query]) => query).find((query) => query.includes('CREATE VECTOR INDEX'));
    expect(create).toContain('`vector.dimensions`: 768');
    expect(create).not.toContain('1024');
  });

  it('reads dimensions that the driver returns as Neo4j integers', async () => {
    const neo4jInteger = neo4j.int(768);
    const before = allFiltered.map((index) =>
      index.name === 'session_notes_idx'
        ? { ...shown(index.name, ['embedding']), options: { indexConfig: { 'vector.dimensions': neo4jInteger } } }
        : index,
    );
    const db = makeDb(before, allFiltered);
    const results = await rebuildVectorIndexesWithProjectFilter(db, 1024);
    expect(results.find((r) => r.indexName === 'session_notes_idx')?.outcome).toBe('rebuilt');
    expect(db.run.mock.calls.map(([query]) => query).join()).toContain('`vector.dimensions`: 768');
  });

  it('retries exactly once when an old-definition server recreated the index unfiltered, then succeeds', async () => {
    const unfiltered = allFiltered.map((index) =>
      index.name === 'session_notes_idx' ? shown(index.name, ['embedding']) : index,
    );
    // read, verify after first create (raced: still unfiltered), verify after retry (filtered)
    const db = makeDb(unfiltered, unfiltered, allFiltered);
    const results = await rebuildVectorIndexesWithProjectFilter(db, 768);

    expect(results.find((r) => r.indexName === 'session_notes_idx')?.outcome).toBe('rebuilt');
    expect(db.statements.filter((s) => s.startsWith('CYPHER 25 CREATE'))).toHaveLength(2);
    expect(db.statements.filter((s) => s === 'DROP INDEX session_notes_idx IF EXISTS')).toHaveLength(2);
  });

  it('reports failed after exactly one retry when the index still lacks projectId', async () => {
    const unfiltered = allFiltered.map((index) =>
      index.name === 'session_notes_idx' ? shown(index.name, ['embedding']) : index,
    );
    const db = makeDb(unfiltered);
    const results = await rebuildVectorIndexesWithProjectFilter(db, 768);

    expect(results.find((r) => r.indexName === 'session_notes_idx')).toEqual({
      indexName: 'session_notes_idx',
      outcome: 'failed',
      reason: 'still not ONLINE with projectId after 2 attempts',
    });
    expect(db.statements.filter((s) => s.startsWith('CYPHER 25 CREATE'))).toHaveLength(2);
    expect(results.filter((r) => r.outcome === 'unchanged')).toHaveLength(3);
  });

  it('keeps going and reports the reason when one index throws', async () => {
    const unfiltered = allFiltered.map((index) =>
      index.name === 'session_notes_idx' ? shown(index.name, ['embedding']) : index,
    );
    const db = makeDb(unfiltered);
    db.run.mockImplementation(async (query: string) => {
      if (query.startsWith('SHOW VECTOR INDEXES')) return unfiltered;
      if (query.startsWith('DROP INDEX')) throw new Error('lock timeout');
      return [];
    });
    const results = await rebuildVectorIndexesWithProjectFilter(db, 768);
    expect(results.find((r) => r.indexName === 'session_notes_idx')).toEqual({
      indexName: 'session_notes_idx',
      outcome: 'failed',
      reason: 'lock timeout',
    });
    expect(results).toHaveLength(4);
  });

  describe('when creating the filtered index throws after the drop', () => {
    const unfiltered = allFiltered.map((index) =>
      index.name === 'session_notes_idx' ? shown(index.name, ['embedding'], 512) : index,
    );

    const dbFailing = (failRestore: boolean) => {
      const statements: string[] = [];
      const run = vi.fn(async (query: string) => {
        if (query.startsWith('SHOW VECTOR INDEXES')) return unfiltered;
        statements.push(query);
        if (query.includes('CYPHER 25')) throw new Error('Unsupported syntax');
        if (failRestore && query.includes('CREATE VECTOR INDEX')) throw new Error('disk full');
        return [];
      });
      return { run, statements };
    };

    it('recreates the original unfiltered definition at its original dimensions and reports failed', async () => {
      const db = dbFailing(false);
      const results = await rebuildVectorIndexesWithProjectFilter(db, 768);

      expect(results.find((r) => r.indexName === 'session_notes_idx')).toEqual({
        indexName: 'session_notes_idx',
        outcome: 'failed',
        reason: 'Unsupported syntax; the unfiltered index was restored',
      });
      const restore = db.statements.find((s) => s.includes('CREATE VECTOR INDEX') && !s.includes('CYPHER 25'));
      expect(restore).toContain('`vector.dimensions`: 512');
      expect(restore).not.toContain('projectId');
    });

    it('reports both errors when the restore fails too', async () => {
      const results = await rebuildVectorIndexesWithProjectFilter(dbFailing(true), 768);

      expect(results.find((r) => r.indexName === 'session_notes_idx')?.reason).toBe(
        'Unsupported syntax; restoring the unfiltered index also failed: disk full. The index is missing.',
      );
    });
  });
});
