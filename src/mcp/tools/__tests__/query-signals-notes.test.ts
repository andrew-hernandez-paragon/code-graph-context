import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../handlers/query-signals.handler.js', () => ({
  probeEmbeddingsHealth: vi.fn(),
  searchCodeHybrid: vi.fn(async () => []),
  projectCodeResult: vi.fn(),
}));
vi.mock('../../handlers/note-search.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../handlers/note-search.js')>()),
  searchSessionNotes: vi.fn(async () => []),
}));
vi.mock('../../../core/embeddings/embeddings.service.js', () => ({
  EmbeddingsService: class {
    embedText = vi.fn(async () => [0.1, 0.2]);
  },
}));

import { searchSessionNotes } from '../../handlers/note-search.js';
import { probeEmbeddingsHealth, searchCodeHybrid } from '../../handlers/query-signals.handler.js';
import { runQuerySignals } from '../query-signals.tool.js';

const noteRow = (id: string, projectId: string, relevance: number | null) => ({
  id,
  projectId,
  topic: id,
  content: 'c',
  category: 'insight',
  severity: 'info',
  relevance,
  lastValidated: 1,
  createdAt: 1,
  aboutNodes: [],
  aboutNodeIds: [],
});

describe('query_signals notes source', () => {
  const run = vi.fn();
  const db = { run } as never;

  beforeEach(() => {
    run.mockReset();
    vi.mocked(searchCodeHybrid).mockClear();
    vi.mocked(searchSessionNotes).mockReset().mockResolvedValue([]);
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', 'false');
    vi.stubEnv('EMBEDDING_MODEL', 'BAAI/bge-base-en-v1.5');
    vi.mocked(probeEmbeddingsHealth).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('searches notes through the shared note search with the codebases and filters given', async () => {
    await runQuerySignals(db, {
      projectIds: ['p1', 'p2'],
      codebaseProjectIds: ['p1'],
      query: 'q',
      sources: ['notes'],
      limitPerSource: 3,
      since: '1000',
    });

    expect(vi.mocked(searchSessionNotes).mock.calls[0][1]).toMatchObject({
      projectIds: ['p1', 'p2'],
      codebaseProjectIds: ['p1'],
      query: 'q',
      queryEmbedding: [0.1, 0.2],
      limit: 3,
      minSimilarity: 0.8,
      minSimilarityRequested: false,
      filters: { sinceMs: 1000, includeSuperseded: false },
    });
  });

  it('groups note results by project', async () => {
    vi.mocked(searchSessionNotes).mockResolvedValue([
      { ...noteRow('a', 'p1', 0.9), rerankScore: 0.7, matchedBy: ['vector'] },
      { ...noteRow('b', 'p2', 0.8), rerankScore: 0.4, matchedBy: ['keyword'] },
    ]);

    const response = await runQuerySignals(db, {
      projectIds: ['p1', 'p2'],
      query: 'q',
      sources: ['notes'],
      groupBy: 'project',
    });

    expect(response).toMatchObject({
      projects: {
        p1: { sources: { notes: { count: 1, results: [{ rerankScore: 0.7, matchedBy: ['vector'] }] } } },
        p2: { sources: { notes: { count: 1 } } },
      },
    });
  });

  it('falls back to recent notes without a vector search when embeddings are unavailable', async () => {
    vi.mocked(probeEmbeddingsHealth).mockResolvedValue(false);
    run.mockResolvedValue([noteRow('a', 'p1', null)]);

    const response = await runQuerySignals(db, { projectIds: ['p1'], query: 'q', sources: ['notes'] });

    const [query, params] = run.mock.calls[0];
    expect(query).toContain('MATCH (n:SessionNote)');
    expect(query).not.toContain('SEARCH');
    expect(params).not.toHaveProperty('queryEmbedding');
    expect(response).toMatchObject({ sources: { notes: { skipped: 'semantic-ranking-unavailable' } } });
  });

  describe('minSimilarity', () => {
    it('uses the calibrated floor for notes and 0.5 for code when the caller passes none', async () => {
      await runQuerySignals(db, { projectIds: ['p1'], query: 'q', sources: ['code', 'notes'] });

      expect(vi.mocked(searchSessionNotes).mock.calls[0][1]).toMatchObject({
        minSimilarity: 0.8,
        minSimilarityRequested: false,
      });
      expect(vi.mocked(searchCodeHybrid).mock.calls[0][1]).toMatchObject({ query: 'q', minSimilarity: 0.5 });
    });

    it('uses the long-standing recall default for notes under a model with no calibration', async () => {
      vi.stubEnv('EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2');
      await runQuerySignals(db, { projectIds: ['p1'], query: 'q', sources: ['notes'] });

      expect(vi.mocked(searchSessionNotes).mock.calls[0][1]).toMatchObject({ minSimilarity: 0.3 });
    });

    it('applies the caller value to both code and notes', async () => {
      await runQuerySignals(db, { projectIds: ['p1'], query: 'q', sources: ['code', 'notes'], minSimilarity: 0.65 });

      expect(vi.mocked(searchSessionNotes).mock.calls[0][1]).toMatchObject({
        minSimilarity: 0.65,
        minSimilarityRequested: true,
      });
      expect(vi.mocked(searchCodeHybrid).mock.calls[0][1]).toMatchObject({ minSimilarity: 0.65 });
    });
  });
});
