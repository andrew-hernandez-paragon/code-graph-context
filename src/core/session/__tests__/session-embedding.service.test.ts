import { describe, expect, it, vi } from 'vitest';

import { QUERIES } from '../../../storage/neo4j/neo4j.service.js';
import { SessionEmbeddingService } from '../session-embedding.service.js';

vi.mock('../../utils/file-utils.js', () => ({ debugLog: vi.fn() }));

const embeddings = (embedText: () => Promise<number[]>) => ({
  provider: 'local' as const,
  model: 'test-model',
  embedText,
});

describe('SessionEmbeddingService', () => {
  const note = { noteId: 'note_1', projectId: 'proj_a', topic: 'retry cap', content: 'The cap is five' };

  it('embeds the topic and content of a note and stores the vector with its provider and model', async () => {
    const run = vi.fn().mockResolvedValue([]);
    const embedText = vi.fn().mockResolvedValue([0.5, 0.25]);

    const stored = await new SessionEmbeddingService({ run }, embeddings(embedText)).embedNote(note);

    expect(stored).toBe(true);
    expect(embedText).toHaveBeenCalledWith('retry cap\n\nThe cap is five');
    expect(run).toHaveBeenCalledWith(QUERIES.SET_NOTE_EMBEDDING_QUERY, {
      noteId: 'note_1',
      projectId: 'proj_a',
      embedding: [0.5, 0.25],
      embeddingProvider: 'local',
      embeddingModel: 'test-model',
    });
  });

  it('embeds a bookmark from its non-empty text parts', async () => {
    const run = vi.fn().mockResolvedValue([]);
    const embedText = vi.fn().mockResolvedValue([1]);

    const stored = await new SessionEmbeddingService({ run }, embeddings(embedText)).embedBookmark({
      bookmarkId: 'bookmark_1',
      projectId: 'proj_a',
      taskContext: 'retry cap',
      summary: 'Working on the cap',
      findings: '',
      nextSteps: 'Add a test',
    });

    expect(stored).toBe(true);
    expect(embedText).toHaveBeenCalledWith('retry cap\n\nWorking on the cap\n\nAdd a test');
    expect(run).toHaveBeenCalledWith(
      QUERIES.SET_BOOKMARK_EMBEDDING_QUERY,
      expect.objectContaining({ bookmarkId: 'bookmark_1', projectId: 'proj_a' }),
    );
  });

  it('reports false and writes nothing when the embedder fails', async () => {
    const run = vi.fn();
    const service = new SessionEmbeddingService(
      { run },
      embeddings(() => Promise.reject(new Error('sidecar down'))),
    );

    expect(await service.embedNote(note)).toBe(false);
    expect(await service.reembedNote(note)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports false when storing the vector fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('write failed'));
    const service = new SessionEmbeddingService(
      { run },
      embeddings(() => Promise.resolve([1])),
    );

    expect(await service.reembedNote(note)).toBe(false);
  });
});
