import { describe, expect, it, vi } from 'vitest';

import { searchSessionNotes } from '../session-recall.tool.js';

describe('session note search', () => {
  const params = { projectIds: ['project'], limit: 5, queryEmbedding: [0.1] };

  it('returns chunk-aware results when the index is available', async () => {
    const rows = [{ id: 'note', relevance: 0.9 }];
    const run = vi.fn().mockResolvedValue(rows);
    expect(await searchSessionNotes({ run }, params)).toBe(rows);
    expect(run).toHaveBeenCalledTimes(1);
    const query: string = run.mock.calls[0][0];
    expect(query.startsWith('CYPHER 25')).toBe(true);
    expect(query).toContain('VECTOR INDEX session_notes_idx');
    expect(query).toContain('VECTOR INDEX session_note_chunks_idx');
    expect(query).toContain('UNWIND $projectIds AS scopeId');
    expect(query).toContain('WHERE note.projectId = scopeId');
    expect(query).toContain('WHERE chunk.projectId = scopeId');
    expect(query).not.toContain('queryNodes');
  });

  it('names the index when it cannot be searched by project', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('filter not declared'), { gqlStatus: '22ND3' }));
    await expect(searchSessionNotes({ run }, params)).rejects.toThrow(
      'Vector index session_notes_idx does not declare projectId as a filter property',
    );
  });

  it.each([
    'Connection refused',
    'There is no such vector schema index: session_notes_idx',
    'There is no such vector schema index: session_note_chunks_idx',
    'session_note_chunks_idx requires 1024 dimensions',
  ])('rethrows the error without a fallback search: %s', async (message) => {
    const run = vi.fn().mockRejectedValue(new Error(message));
    await expect(searchSessionNotes({ run }, params)).rejects.toThrow(message);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
