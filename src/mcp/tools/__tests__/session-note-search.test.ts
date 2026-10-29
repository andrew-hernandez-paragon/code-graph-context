import { describe, expect, it, vi } from 'vitest';

import {
  fuseNoteChannels,
  KEYWORD_NOTE_CANDIDATES_QUERY,
  NO_NOTE_FILTERS,
  NOTE_ROWS_QUERY,
  rankNoteCandidates,
  searchSessionNotes,
  VECTOR_NOTE_CANDIDATES_QUERY,
  type NoteSearchOptions,
} from '../../handlers/note-search.js';

const options = (overrides: Partial<NoteSearchOptions> = {}): NoteSearchOptions => ({
  projectIds: ['project'],
  codebaseProjectIds: [],
  query: 'retry budget for flushes',
  queryEmbedding: [0.1],
  limit: 5,
  minSimilarity: 0.8,
  minSimilarityRequested: false,
  filters: NO_NOTE_FILTERS,
  ...overrides,
});

const noteRow = (id: string) => ({ id, projectId: 'project', topic: `topic ${id}`, content: `content ${id}` });

/** A Neo4j stub that answers each note query from fixed rows. */
const stubNeo4j = (vector: { id: string; score: number }[], keyword: string[] | Error) => {
  const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
    if (query === VECTOR_NOTE_CANDIDATES_QUERY) return vector;
    if (query === KEYWORD_NOTE_CANDIDATES_QUERY) {
      if (keyword instanceof Error) throw keyword;
      return keyword.map((id) => ({ id, score: 1 }));
    }
    if (query === NOTE_ROWS_QUERY) return (params.ids as string[]).map(noteRow);
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  });
  return { run } as never;
};

describe('note search', () => {
  it('searches notes and note chunks by vector, scoped to each project', () => {
    expect(VECTOR_NOTE_CANDIDATES_QUERY.startsWith('CYPHER 25')).toBe(true);
    expect(VECTOR_NOTE_CANDIDATES_QUERY).toContain('VECTOR INDEX session_notes_idx');
    expect(VECTOR_NOTE_CANDIDATES_QUERY).toContain('VECTOR INDEX session_note_chunks_idx');
    expect(VECTOR_NOTE_CANDIDATES_QUERY).toContain('WHERE note.projectId = scopeId');
    expect(KEYWORD_NOTE_CANDIDATES_QUERY).toContain("queryNodes('session_notes_fts_idx'");
  });

  it('fuses channels by rank, so a note two channels found outranks one found by either', () => {
    const fused = fuseNoteChannels([
      {
        channel: 'vector',
        ids: ['a', 'b'],
        scores: new Map([
          ['a', 0.9],
          ['b', 0.85],
        ]),
      },
      { channel: 'keyword', ids: ['c', 'b'] },
    ]);
    expect(fused.map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]).toMatchObject({ channels: ['vector', 'keyword'], vectorScore: 0.85 });
    expect(fused[2]).toMatchObject({ channels: ['keyword'], vectorScore: null });
  });

  it('orders by reranker score and cuts at the calibrated floor', async () => {
    const neo4j = stubNeo4j(
      [
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0.82 },
      ],
      ['c'],
    );
    const rerank = vi.fn().mockResolvedValue([0.01, 0.6, 0.3]);
    const rows = await searchSessionNotes(neo4j, options({ rerank }));
    expect(rerank).toHaveBeenCalledWith('retry budget for flushes', [
      'topic a\ncontent a',
      'topic c\ncontent c',
      'topic b\ncontent b',
    ]);
    expect(rows.map((row) => [row.id, row.rerankScore, row.matchedBy])).toEqual([
      ['c', 0.6, ['keyword']],
      ['b', 0.3, ['vector']],
    ]);
    expect(rows[1].relevance).toBe(0.82);
  });

  it('without a reranker keeps keyword matches and holds vector-only matches to minSimilarity', async () => {
    const neo4j = stubNeo4j(
      [
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0.7 },
      ],
      ['c'],
    );
    const rows = await searchSessionNotes(neo4j, options({ rerank: vi.fn().mockResolvedValue(null) }));
    expect(rows.map((row) => row.id)).toEqual(['a', 'c']);
    expect(rows.every((row) => row.rerankScore === null)).toBe(true);
  });

  it("lets the caller's minSimilarity replace the reranker floor", () => {
    const candidates = fuseNoteChannels([
      {
        channel: 'vector',
        ids: ['a', 'b'],
        scores: new Map([
          ['a', 0.6],
          ['b', 0.4],
        ]),
      },
    ]);
    const ranked = rankNoteCandidates(
      candidates,
      [0.001, 0.002],
      { minSimilarity: 0.5, minSimilarityRequested: true, limit: 5 },
      0.02,
    );
    expect(ranked.map((c) => c.id)).toEqual(['a']);
  });

  it('continues on the vector channel when the keyword index is missing', async () => {
    const neo4j = stubNeo4j([{ id: 'a', score: 0.9 }], new Error('There is no such fulltext schema index'));
    const rows = await searchSessionNotes(neo4j, options({ rerank: vi.fn().mockResolvedValue(null) }));
    expect(rows.map((row) => row.id)).toEqual(['a']);
  });

  it('returns nothing without querying rows when no channel finds a note', async () => {
    const neo4j = stubNeo4j([], []);
    expect(await searchSessionNotes(neo4j, options({ rerank: vi.fn() }))).toEqual([]);
  });
});
