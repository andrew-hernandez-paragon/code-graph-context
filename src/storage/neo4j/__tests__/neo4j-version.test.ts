import { describe, expect, it } from 'vitest';

import {
  describeOldNeo4j,
  parseNeo4jVersion,
  readNeo4jVersion,
  supportsProjectFilteredSearch,
} from '../neo4j-version.js';

describe('Neo4j version floor', () => {
  it.each([
    ['5.23.0', { major: 5, minor: 23, patch: 0 }, false],
    ['5.26.12', { major: 5, minor: 26, patch: 12 }, false],
    ['2026.01.3', { major: 2026, minor: 1, patch: 3 }, false],
    ['2026.02.2', { major: 2026, minor: 2, patch: 2 }, true],
    ['2026.10.1', { major: 2026, minor: 10, patch: 1 }, true],
  ])('%s', (text, parsed, supported) => {
    expect(parseNeo4jVersion(text)).toEqual(parsed);
    expect(supportsProjectFilteredSearch(parsed)).toBe(supported);
  });

  it('rejects text that is not a version', () => {
    expect(parseNeo4jVersion('unknown')).toBeNull();
  });

  it('names the found version, the floor and both fixes in the old-server message', () => {
    const message = describeOldNeo4j({ major: 5, minor: 26, patch: 12 });
    expect(message).toContain('Neo4j 5.26.12');
    expect(message).toContain('2026.02');
    expect(message).toContain('brew upgrade neo4j');
    expect(message).toContain('migrate-from-docker');
  });

  it('reads the kernel version from dbms.components', async () => {
    const db = { run: async () => [{ version: '2026.02.2' }] };
    expect(await readNeo4jVersion(db)).toEqual({ major: 2026, minor: 2, patch: 2 });
  });
});
