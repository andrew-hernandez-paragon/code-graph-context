import { describe, expect, it, vi } from 'vitest';

import { searchSessionNotes } from '../session-recall.tool.js';

describe('session note search without a chunk index', () => {
  const params = { projectId: 'project', limit: 5, queryEmbedding: [0.1] };

  it('returns chunk-aware results when the index is available', async () => {
    const rows = [{ id: 'note', relevance: 0.9 }];
    const run = vi.fn().mockResolvedValue(rows);
    expect(await searchSessionNotes({ run }, params)).toBe(rows);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('session_note_chunks_idx');
  });

  it('falls back to parent note search when the optional chunk index is missing', async () => {
    const rows = [{ id: 'note', relevance: 0.8 }];
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('There is no such vector schema index: session_note_chunks_idx'))
      .mockResolvedValueOnce(rows);
    expect(await searchSessionNotes({ run }, params)).toBe(rows);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toContain('session_notes_idx');
    expect(run.mock.calls[1][0]).not.toContain('session_note_chunks_idx');
    expect(run.mock.calls[1][1]).toBe(params);
  });

  it.each([
    'Connection refused',
    'There is no such vector schema index: session_notes_idx',
    'session_note_chunks_idx requires 1024 dimensions',
  ])('does not hide other errors: %s', async (message) => {
    const run = vi.fn().mockRejectedValue(new Error(message));
    await expect(searchSessionNotes({ run }, params)).rejects.toThrow(message);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
