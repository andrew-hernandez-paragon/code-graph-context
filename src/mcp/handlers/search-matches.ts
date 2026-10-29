/**
 * The ranked hits of a hybrid code search, as structured fields a caller can
 * read without parsing prose: rank 1 is the node the traversal starts from.
 */

import type { AnchoredNote } from './anchored-notes.js';
import type { FusedSearchRow, SearchChannel } from './query-signals.handler.js';

export interface SearchMatch {
  readonly rank: number;
  readonly id: string;
  readonly name: string;
  readonly filePath: string | null;
  /** Reciprocal-rank fusion of the vector and keyword channels; orders the matches. */
  readonly fusedScore: number;
  /** Neo4j's vector index score, (1 + cosine) / 2; null when only keywords found the node. */
  readonly vectorScore: number | null;
  /** The same similarity as plain cosine, the scale embedding thresholds are usually given in. */
  readonly vectorCosine: number | null;
  /** BM25 score; unbounded, so compare it only within one search. */
  readonly lexicalScore: number | null;
  readonly channels: readonly SearchChannel[];
}

const round = (value: number, places: number): number => Number(value.toFixed(places));

const stringProperty = (properties: Record<string, unknown>, key: string): string | null => {
  const value = properties[key];
  return typeof value === 'string' ? value : null;
};

export const searchMatchesOf = (rows: readonly FusedSearchRow[]): SearchMatch[] =>
  rows.map((row, index) => {
    const { properties } = row.node;
    const id = stringProperty(properties, 'id') ?? row.node.id;
    return {
      rank: index + 1,
      id,
      name: stringProperty(properties, 'name') ?? id,
      filePath: stringProperty(properties, 'filePath'),
      fusedScore: round(row.fusedScore, 4),
      vectorScore: row.vectorScore === null ? null : round(row.vectorScore, 3),
      vectorCosine: row.vectorScore === null ? null : round(2 * row.vectorScore - 1, 3),
      lexicalScore: row.lexicalScore === null ? null : round(row.lexicalScore, 2),
      channels: row.channels,
    };
  });

/**
 * Adds the matches, and the notes anchored to them, to a traversal response. The traversal answers in JSON,
 * except when the start node has no connections, which it reports as a
 * sentence; that sentence is kept as `message` so the result is always JSON.
 */
export const withSearchMatches = (
  traversalText: string,
  matches: readonly SearchMatch[],
  notes: readonly AnchoredNote[] = [],
): string => {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(traversalText);
    payload =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : { message: traversalText };
  } catch {
    payload = { message: traversalText };
  }
  return JSON.stringify({ ...payload, matches, ...(notes.length > 0 ? { notes } : {}) });
};

/** The node ids in a traversal response's nodes map; [] when the response is not that JSON. */
export const traversalNodeIdsOf = (traversalText: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(traversalText);
    const nodes = typeof parsed === 'object' && parsed !== null ? (parsed as { nodes?: unknown }).nodes : undefined;
    return typeof nodes === 'object' && nodes !== null ? Object.keys(nodes) : [];
  } catch {
    return [];
  }
};
