import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { MIGRATE_SESSION_NOTE_PROPERTIES_QUERY } from '../service-init.js';

// Opt in against a local Neo4j instance. READ transactions reject database writes.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('SessionNote startup migration in Neo4j', () => {
  let db: Neo4jService;
  beforeAll(() => {
    db = new Neo4jService();
  });
  afterAll(async () => {
    await db?.close();
  });

  const selection = MIGRATE_SESSION_NOTE_PROPERTIES_QUERY.match(/WHERE[\s\S]*?(?=OPTIONAL MATCH)/)![0];

  it('selects only notes missing aboutNodeIds or lastValidated, not current notes without supersededBy', async () => {
    const notes = [
      { id: 'current', aboutNodeIds: [], lastValidated: 1 },
      { id: 'superseded', aboutNodeIds: ['code'], lastValidated: 1, supersededBy: 'note_newer' },
      { id: 'missing-about', lastValidated: 1 },
      { id: 'missing-validated', aboutNodeIds: [] },
    ];
    const session = db.getDriver().session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.executeRead(
        (tx) => tx.run(`UNWIND $notes AS n WITH n ${selection} RETURN n.id AS id`, { notes }),
        { timeout: 10000 },
      );
      expect(result.records.map((record) => record.get('id'))).toEqual(['missing-about', 'missing-validated']);
    } finally {
      await session.close();
    }
  });
});
