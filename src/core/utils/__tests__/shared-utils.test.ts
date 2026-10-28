import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { toNumber, toNumberOrNull } from '../shared-utils.js';

describe('toNumber', () => {
  it('reads a Neo4j integer, a number, and treats a missing value as 0', () => {
    expect(toNumber(neo4j.int(42))).toBe(42);
    expect(toNumber(7)).toBe(7);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });
});

describe('toNumberOrNull', () => {
  it('reads a Neo4j integer and a number the same way', () => {
    expect(toNumberOrNull(neo4j.int(1_700_000_000_000))).toBe(1_700_000_000_000);
    expect(toNumberOrNull(0)).toBe(0);
  });

  it('keeps a missing value as null', () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
  });
});
