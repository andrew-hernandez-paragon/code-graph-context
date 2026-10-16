import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readProviderRecord, writeProviderRecord } from '../neo4j-provider-record.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cgc-record-'));
  process.env.CGC_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.CGC_CONFIG_DIR;
});

describe('provider record', () => {
  it('reads null when the file is missing', () => {
    expect(readProviderRecord()).toBeNull();
  });

  it('round-trips a written record', () => {
    writeProviderRecord({ provider: 'native', boltPort: 7687, httpPort: 7474 });
    expect(readProviderRecord()).toEqual({ provider: 'native', boltPort: 7687, httpPort: 7474 });
  });

  it.each([
    ['not json', 'nope'],
    ['no neo4j key', '{}'],
    ['unknown provider', '{"neo4j":{"provider":"aura","boltPort":1,"httpPort":2}}'],
    ['bad port', '{"neo4j":{"provider":"docker","boltPort":"7687","httpPort":7474}}'],
  ])('reads null for %s', (_name, content) => {
    writeFileSync(join(dir, 'config.json'), content);
    expect(readProviderRecord()).toBeNull();
  });
});
