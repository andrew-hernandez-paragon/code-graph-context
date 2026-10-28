import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BACKFILL_PROJECT_KINDS_QUERY } from '../../core/projects/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';

// Opt in against a local Neo4j instance. READ transactions reject database writes.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('Project kind backfill in Neo4j', () => {
  let db: Neo4jService;
  beforeAll(() => {
    db = new Neo4jService();
  });
  afterAll(async () => {
    await db?.close();
  });

  const selection = BACKFILL_PROJECT_KINDS_QUERY.match(/WHERE[\s\S]*?(?=SET)/)![0];
  const rule = BACKFILL_PROJECT_KINDS_QUERY.match(/SET p\.kind = ([\s\S]*?)\n\s*REMOVE/)![1];

  const projects = [
    { projectId: 'parsed', status: 'complete', path: '/work/parsed' },
    { projectId: 'parsing', status: 'parsing', path: '/work/parsing' },
    { projectId: 'failed', status: 'failed' },
    { projectId: 'directory', path: '/work/directory' },
    { projectId: 'collection' },
    { projectId: 'legacy-synthetic', status: 'synthetic', synthetic: true },
    { projectId: 'already-set', kind: 'directory', status: 'complete', path: '/work/already-set' },
  ];

  it("selects only Project nodes without kind and gives each the rule's kind", async () => {
    const session = db.getDriver().session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.executeRead(
        (tx) =>
          tx.run(`UNWIND $projects AS p WITH p ${selection} RETURN p.projectId AS id, ${rule} AS kind`, { projects }),
        { timeout: 10000 },
      );
      expect(result.records.map((record) => [record.get('id'), record.get('kind')])).toEqual([
        ['parsed', 'codebase'],
        ['parsing', 'codebase'],
        ['failed', 'codebase'],
        ['directory', 'directory'],
        ['collection', 'collection'],
        ['legacy-synthetic', 'collection'],
      ]);
    } finally {
      await session.close();
    }
  });
});
