/**
 * Unit tests — hybrid search primitives (0014)
 *
 * Covers the two pure functions behind `searchCodeHybrid`: Lucene query
 * construction (escaping, filtering, boosting) and reciprocal rank fusion.
 * Both are deterministic, so no Neo4j mock is needed here — the Cypher path is
 * already covered by search-codebase.snapshot.test.ts.
 */

import { describe, it, expect } from 'vitest';

import { buildLuceneQuery, fuseRRF, RRF_K } from '../../handlers/query-signals.handler.js';
import type { SearchCodeRawRow } from '../../handlers/query-signals.handler.js';

const makeRow = (id: string, score: number): SearchCodeRawRow => ({
  node: {
    id,
    labels: ['Function'],
    properties: { id, name: id, filePath: `src/${id}.ts` },
  },
  score,
  projectId: 'proj_test',
});

describe('buildLuceneQuery', () => {
  it('boosts the name field above sourceCode', () => {
    expect(buildLuceneQuery('searchCodeRaw')).toBe('name:(searchCodeRaw)^3 OR sourceCode:(searchCodeRaw)');
  });

  it('escapes every Lucene reserved character so user text is matched literally', () => {
    // Unescaped, `foo()` would parse as an empty group and `bar?` as a wildcard.
    expect(buildLuceneQuery('foo() bar?')).toBe('name:(foo\\(\\) bar\\?)^3 OR sourceCode:(foo\\(\\) bar\\?)');
  });

  it('escapes a leading hyphen rather than letting it negate the clause', () => {
    expect(buildLuceneQuery('-cache')).toContain('\\-cache');
  });

  it('drops tokens with no letter or digit', () => {
    expect(buildLuceneQuery('parse >>> tree')).toBe('name:(parse tree)^3 OR sourceCode:(parse tree)');
  });

  it('returns null when nothing searchable remains', () => {
    expect(buildLuceneQuery('   ')).toBeNull();
    expect(buildLuceneQuery('*** ???')).toBeNull();
  });

  it('caps term count to stay under the Lucene clause limit', () => {
    const query = buildLuceneQuery(Array.from({ length: 100 }, (_, i) => `term${i}`).join(' '));
    expect(query).not.toBeNull();
    expect(query!.match(/term\d+/g)!.length).toBe(32 * 2); // 32 terms, in both field clauses
  });

  it('keeps unicode identifiers', () => {
    expect(buildLuceneQuery('café')).toContain('café');
  });
});

describe('fuseRRF', () => {
  it('ranks a node found by both channels above one found by either alone', () => {
    const fused = fuseRRF([
      { channel: 'vector', rows: [makeRow('a', 0.9), makeRow('b', 0.88)] },
      { channel: 'lexical', rows: [makeRow('b', 12.4), makeRow('c', 3.1)] },
    ]);

    expect(fused[0].node.properties.id).toBe('b');
    expect(fused[0].channels).toEqual(['vector', 'lexical']);
    expect(fused[0].vectorScore).toBe(0.88);
    expect(fused[0].lexicalScore).toBe(12.4);
  });

  it('lets a low vector rank win on a strong lexical rank', () => {
    // The case this feature exists for: cosine cannot separate same-stem
    // symbols, so the exact match lands mid-pack, while BM25 puts it first.
    const vector = ['w', 'x', 'y', 'exact', 'z'].map((id, i) => makeRow(id, 0.86 - i * 0.002));
    const fused = fuseRRF([
      { channel: 'vector', rows: vector },
      { channel: 'lexical', rows: [makeRow('exact', 19.5)] },
    ]);

    expect(fused[0].node.properties.id).toBe('exact');
  });

  it('scores a single-channel hit as 1/(k + rank + 1)', () => {
    const fused = fuseRRF([{ channel: 'vector', rows: [makeRow('a', 0.9)] }]);
    expect(fused[0].fusedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('honours a custom k', () => {
    const fused = fuseRRF([{ channel: 'lexical', rows: [makeRow('a', 5)] }], 1);
    expect(fused[0].fusedScore).toBeCloseTo(0.5, 10);
  });

  it('reports score as cosine, and 0 for a lexical-only hit', () => {
    const fused = fuseRRF([
      { channel: 'vector', rows: [makeRow('a', 0.9)] },
      { channel: 'lexical', rows: [makeRow('b', 7.7)] },
    ]);
    const byId = Object.fromEntries(fused.map((r) => [r.node.properties.id, r]));

    expect(byId.a.score).toBe(0.9);
    expect(byId.b.score).toBe(0);
    expect(byId.b.lexicalScore).toBe(7.7);
    expect(byId.b.vectorScore).toBeNull();
  });

  it('returns an empty list when both channels are empty', () => {
    expect(
      fuseRRF([
        { channel: 'vector', rows: [] },
        { channel: 'lexical', rows: [] },
      ]),
    ).toEqual([]);
  });

  it('does not mutate the input rows', () => {
    const row = makeRow('a', 0.9);
    fuseRRF([{ channel: 'vector', rows: [row] }]);
    expect(row).not.toHaveProperty('fusedScore');
  });
});
