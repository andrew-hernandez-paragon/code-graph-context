import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbeddingSidecar } from '../embedding-sidecar.js';

const model = 'BAAI/bge-base-en-v1.5';
const fetchMock = vi.fn();
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const health = (override = {}) => response({ status: 'ok', model, dimensions: 768, ...override });
const embedding = (override = {}) =>
  response({ model, dimensions: 768, embeddings: [Array(768).fill(0.1)], ...override });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sidecar model consistency', () => {
  it('reuses an external sidecar only when its model and dimensions match', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(embedding());
    const sidecar = new EmbeddingSidecar({ model });
    try {
      expect(await sidecar.embed(['code'])).toHaveLength(1);
      expect(sidecar.dimensions).toBe(768);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await sidecar.stop();
    }
  });

  it.each([
    { model: 'codesage/codesage-base-v2', dimensions: 1024 },
    { model: 'sentence-transformers/all-mpnet-base-v2', dimensions: 768 },
    { model: undefined },
    { dimensions: 1024 },
    { dimensions: undefined },
  ])('rejects incompatible health metadata %j before embedding', async (metadata) => {
    fetchMock.mockResolvedValueOnce(health(metadata));
    const sidecar = new EmbeddingSidecar({ model });
    await expect(sidecar.embed(['code'])).rejects.toThrow(/expected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('detects a different model replacing the server after startup', async () => {
    fetchMock
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(embedding())
      .mockResolvedValueOnce(embedding({ model: 'sentence-transformers/all-mpnet-base-v2' }));
    const sidecar = new EmbeddingSidecar({ model });
    try {
      await sidecar.embed(['first']);
      await expect(sidecar.embed(['second'])).rejects.toThrow(/expected BAAI/);
    } finally {
      await sidecar.stop();
    }
  });

  it.each([{ embeddings: [] }, { embeddings: [Array(1024).fill(0)] }])(
    'rejects inconsistent vector payloads %j',
    async (metadata) => {
      fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(embedding(metadata));
      const sidecar = new EmbeddingSidecar({ model });
      try {
        await expect(sidecar.embed(['code'])).rejects.toThrow(/inconsistent/);
      } finally {
        await sidecar.stop();
      }
    },
  );

  it('returns no vectors for an empty batch without starting a server', async () => {
    expect(await new EmbeddingSidecar({ model }).embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
