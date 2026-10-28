import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../handlers/query-signals.handler.js', () => ({
  probeEmbeddingsHealth: vi.fn(),
  searchCodeRaw: vi.fn(async () => []),
  projectCodeResult: vi.fn(),
}));
vi.mock('../../../core/embeddings/embeddings.service.js', () => ({
  EmbeddingsService: class {
    embedText = vi.fn(async () => [0.1, 0.2]);
  },
}));

import { probeEmbeddingsHealth } from '../../handlers/query-signals.handler.js';
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
    vi.mocked(probeEmbeddingsHealth).mockResolvedValue(true);
  });

  it('searches the notes index inside each project with the filters kept', async () => {
    run.mockResolvedValue([noteRow('a', 'p1', 0.9)]);

    await runQuerySignals(db, { projectIds: ['p1', 'p2'], query: 'q', sources: ['notes'], limitPerSource: 3 });

    const [query, params] = run.mock.calls[0];
    expect(query).toContain('CYPHER 25');
    expect(query).toContain('UNWIND $projectIds AS scopeId');
    expect(query).toContain('VECTOR INDEX session_notes_idx FOR $queryEmbedding');
    expect(query).toContain('WHERE n.projectId = scopeId');
    expect(query).toContain('LIMIT $candidates');
    expect(query).not.toContain('db.index.vector.queryNodes');
    expect(query).not.toMatch(/\}\s*WHERE/);
    expect(query).toContain('n.supersededBy IS NULL');
    expect(query).toContain('n.expiresAt > timestamp()');
    expect(query).toContain('relevance >= $minSimilarity');
    expect(params).toMatchObject({
      projectIds: ['p1', 'p2'],
      limit: 3,
      candidates: 300,
      queryEmbedding: [0.1, 0.2],
      minSimilarity: 0.5,
    });
  });

  it('groups note results by project', async () => {
    run.mockResolvedValue([noteRow('a', 'p1', 0.9), noteRow('b', 'p2', 0.8)]);

    const response = await runQuerySignals(db, {
      projectIds: ['p1', 'p2'],
      query: 'q',
      sources: ['notes'],
      groupBy: 'project',
    });

    expect(response).toMatchObject({
      projects: { p1: { sources: { notes: { count: 1 } } }, p2: { sources: { notes: { count: 1 } } } },
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
});
