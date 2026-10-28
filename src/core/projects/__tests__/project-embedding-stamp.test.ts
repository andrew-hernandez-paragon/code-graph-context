import { describe, expect, it, vi } from 'vitest';

import { ProjectService, SELECT_UNSTAMPED_CODEBASES_QUERY } from '../project.service.js';

type Row = Record<string, unknown>;

const serviceAnswering = (selected: Row[], stamped = selected.length) => {
  const run = vi.fn(async (query: string): Promise<Row[]> => {
    if (query === SELECT_UNSTAMPED_CODEBASES_QUERY) return selected;
    return [{ stamped }];
  });
  return { service: new ProjectService({ run }), run };
};

describe('ProjectService.updateParseStatus', () => {
  it('records the model and dimensions that embedded a completed parse', async () => {
    const run = vi.fn(async () => []);

    await new ProjectService({ run }).updateParseStatus({
      projectId: 'proj_a',
      status: 'complete',
      nodeCount: 10,
      edgeCount: 20,
      embedding: { model: 'BAAI/bge-base-en-v1.5', dimensions: 768 },
    });

    expect(run).toHaveBeenCalledWith(expect.any(String), {
      projectId: 'proj_a',
      status: 'complete',
      nodeCount: 10,
      edgeCount: 20,
      embeddingModel: 'BAAI/bge-base-en-v1.5',
      embeddingDimensions: 768,
    });
  });

  it('sends null for the embedding of a failed parse, which leaves any earlier stamp', async () => {
    const run = vi.fn(async () => []);

    await new ProjectService({ run }).updateParseStatus({
      projectId: 'proj_a',
      status: 'failed',
      nodeCount: 0,
      edgeCount: 0,
    });

    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ embeddingModel: null, embeddingDimensions: null }),
    );
  });
});

describe('ProjectService.backfillEmbeddingStamps', () => {
  it('stamps each selected codebase with its sample node dimensions and model, null when unknown', async () => {
    const { service, run } = serviceAnswering([
      { projectId: 'proj_a', dimensions: 768, model: 'BAAI/bge-base-en-v1.5' },
      { projectId: 'proj_b', dimensions: { toNumber: () => 1024 }, model: null },
    ]);

    expect(await service.backfillEmbeddingStamps()).toBe(2);
    expect(run).toHaveBeenLastCalledWith(expect.any(String), {
      stamps: [
        { projectId: 'proj_a', dimensions: 768, model: 'BAAI/bge-base-en-v1.5' },
        { projectId: 'proj_b', dimensions: 1024, model: null },
      ],
    });
  });

  it('writes nothing when every codebase is already stamped', async () => {
    const { service, run } = serviceAnswering([]);

    expect(await service.backfillEmbeddingStamps()).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
