import { describe, it, expect } from 'vitest';

import type { FusedSearchRow } from '../query-signals.handler.js';
import { searchMatchesOf, traversalNodeIdsOf, withSearchMatches } from '../search-matches.js';

const row = (overrides: Partial<FusedSearchRow> & { props: Record<string, unknown> }): FusedSearchRow => ({
  node: { id: '4:abc:1', labels: ['Class'], properties: overrides.props },
  score: overrides.vectorScore ?? 0,
  projectId: 'proj_000000000001',
  fusedScore: overrides.fusedScore ?? 0,
  vectorScore: overrides.vectorScore ?? null,
  lexicalScore: overrides.lexicalScore ?? null,
  channels: overrides.channels ?? [],
});

describe('searchMatchesOf', () => {
  it('lists every hit in rank order, the best match included, with each channel score', () => {
    const matches = searchMatchesOf([
      row({
        props: { id: 'proj_000000000001:ClassDeclaration:aa', name: 'LessonNoteWriter', filePath: '/repo/a.ts' },
        fusedScore: 0.032786,
        vectorScore: 0.8954,
        lexicalScore: 19.812,
        channels: ['vector', 'lexical'],
      }),
      row({
        props: { id: 'proj_000000000001:FunctionDeclaration:bb', name: 'uniqueNodeIdsOf' },
        fusedScore: 0.016129,
        lexicalScore: 7.5,
        channels: ['lexical'],
      }),
    ]);

    expect(matches).toEqual([
      {
        rank: 1,
        id: 'proj_000000000001:ClassDeclaration:aa',
        name: 'LessonNoteWriter',
        filePath: '/repo/a.ts',
        fusedScore: 0.0328,
        vectorScore: 0.895,
        vectorCosine: 0.791,
        lexicalScore: 19.81,
        channels: ['vector', 'lexical'],
      },
      {
        rank: 2,
        id: 'proj_000000000001:FunctionDeclaration:bb',
        name: 'uniqueNodeIdsOf',
        filePath: null,
        fusedScore: 0.0161,
        vectorScore: null,
        vectorCosine: null,
        lexicalScore: 7.5,
        channels: ['lexical'],
      },
    ]);
  });

  it('falls back to the database id when the node carries no id or name property', () => {
    const [match] = searchMatchesOf([row({ props: {}, fusedScore: 0.01, channels: ['vector'], vectorScore: 0.5 })]);

    expect(match).toMatchObject({ id: '4:abc:1', name: '4:abc:1', filePath: null, vectorCosine: 0 });
  });
});

describe('withSearchMatches', () => {
  const matches = searchMatchesOf([row({ props: { id: 'n1', name: 'n1' }, fusedScore: 0.02, channels: ['lexical'] })]);

  it('adds the matches to the traversal JSON and keeps its fields', () => {
    const text = withSearchMatches('{"startNodeId":"n1","nodes":{}}', matches);

    expect(JSON.parse(text)).toEqual({ startNodeId: 'n1', nodes: {}, matches });
  });

  it('adds the notes anchored to the matches when there are any', () => {
    const notes = [
      {
        id: 'note_1',
        projectId: 'p',
        topic: 'Retry cap',
        preview: 'The cap is read',
        category: 'insight',
        anchors: ['n1'],
      },
    ];

    expect(JSON.parse(withSearchMatches('{"nodes":{}}', matches, notes))).toEqual({ nodes: {}, matches, notes });
  });

  it('lists the node ids of a traversal, and none for a plain-text answer', () => {
    expect(traversalNodeIdsOf('{"nodes":{"a":{},"b":{}}}')).toEqual(['a', 'b']);
    expect(traversalNodeIdsOf('No connections found for node "n1".')).toEqual([]);
  });

  it('keeps a plain-text traversal answer as message, so the result is still JSON', () => {
    const text = withSearchMatches('No connections found for node "n1".', matches);

    expect(JSON.parse(text)).toEqual({ message: 'No connections found for node "n1".', matches });
  });
});
