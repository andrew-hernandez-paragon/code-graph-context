import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const rebuild = vi.hoisted(() => vi.fn());
const serverVersion = vi.hoisted(() => ({ current: '2026.02.2' }));

vi.mock('../../storage/neo4j/project-filter-index-migration.js', () => ({
  rebuildVectorIndexesWithProjectFilter: rebuild,
}));
vi.mock('../../storage/neo4j/neo4j.service.js', () => ({
  Neo4jService: class {
    run = vi.fn(async (query: string) => {
      if (query === 'FULLTEXT') calls.push('fulltext');
      if (query.includes('dbms.components')) return [{ version: serverVersion.current }];
      return [];
    });
    close = vi.fn(async () => undefined);
  },
  QUERIES: {
    CREATE_EMBEDDED_FULLTEXT_INDEX: 'FULLTEXT',
    CREATE_SESSION_BOOKMARKS_VECTOR_INDEX: () => 'BOOKMARK_INDEX',
    CREATE_PROJECT_ID_INDEX_GRAPHNODE: 'LOOKUP',
    CREATE_PROJECT_FILEPATH_INDEX_GRAPHNODE: 'LOOKUP',
    CREATE_PROJECT_NAME_INDEX_GRAPHNODE: 'LOOKUP',
  },
}));
vi.mock('../../core/projects/index.js', () => ({
  ProjectService: class {
    list = vi.fn(async () => []);
    backfillKinds = vi.fn(async () => 0);
    backfillEmbeddingStamps = vi.fn(async () => 0);
  },
}));
vi.mock('../neo4j-startup.js', () => ({
  STARTUP_RETRY_INTERVAL_MS: 1,
  createNeo4jStartupService: () => ({ ensureRunning: async () => 'already-running' }),
  retryInBackground: vi.fn(),
}));
vi.mock('../../core/embeddings/embeddings.service.js', () => ({
  EmbeddingsService: class {},
  isOpenAIEnabled: () => false,
  isOpenAIAvailable: () => false,
  isOpenAIRequested: () => false,
  getEmbeddingDimensions: () => 768,
  getEmbeddingModel: () => 'test-model',
}));
vi.mock('../tools/natural-language-to-cypher.tool.js', () => ({ initializeNaturalLanguageService: vi.fn() }));
vi.mock('fs/promises', () => ({ default: { writeFile: vi.fn(async () => undefined) } }));

import { initializeServices } from '../service-init.js';

describe('initializeServices vector index rebuild', () => {
  beforeEach(() => {
    calls.length = 0;
    rebuild.mockReset();
    serverVersion.current = '2026.02.2';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('rebuilds the vector indexes with the configured dimensions before the fulltext index step', async () => {
    rebuild.mockImplementation(async () => {
      calls.push('rebuild');
      return [{ indexName: 'session_notes_idx', outcome: 'rebuilt' }];
    });

    await initializeServices();

    expect(rebuild).toHaveBeenCalledWith(expect.anything(), 768);
    expect(calls).toEqual(['rebuild', 'fulltext']);
  });

  it('logs a failed index and keeps starting the remaining steps', async () => {
    rebuild.mockResolvedValue([{ indexName: 'embedded_nodes_idx', outcome: 'failed', reason: 'timed out' }]);

    await initializeServices();

    const logged = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes('embedded_nodes_idx') && line.includes('timed out'))).toBe(true);
    expect(logged.some((line) => line.includes('will fail until'))).toBe(true);
    expect(calls).toEqual(['fulltext']);
  });

  it('logs a thrown rebuild and keeps starting the remaining steps', async () => {
    rebuild.mockRejectedValue(new Error('neo4j unreachable'));

    await initializeServices();

    const logged = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes('neo4j unreachable'))).toBe(true);
    expect(calls).toEqual(['fulltext']);
  });

  it('logs the found version, the floor and the fix on Neo4j 5.x, and skips the rebuild', async () => {
    serverVersion.current = '5.26.12';

    await initializeServices();

    const logged = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes('Neo4j 5.26.12') && line.includes('brew upgrade neo4j'))).toBe(true);
    expect(rebuild).not.toHaveBeenCalled();
    expect(calls).toEqual(['fulltext']);
  });
});
