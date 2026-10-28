import { afterAll, describe, expect, it } from 'vitest';

import { Neo4jService } from '../neo4j.service.js';

const PROBE_LABEL = 'CgcReadOnlyProbe';

// Opt in against a local Neo4j. The write below must be refused; afterAll removes the probe if it ever is not.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('Neo4jService.runReadOnly against Neo4j', () => {
  const db = new Neo4jService();

  afterAll(async () => {
    await db.run(`MATCH (n:${PROBE_LABEL}) DETACH DELETE n`);
    await db.close();
  });

  it('refuses a write, so generated Cypher cannot change the graph', async () => {
    await expect(db.runReadOnly(`CREATE (:${PROBE_LABEL}) RETURN 1 AS created`)).rejects.toThrow();
    const [row] = await db.runReadOnly(`MATCH (n:${PROBE_LABEL}) RETURN count(n) AS probes`);
    expect(Number(row.probes)).toBe(0);
  });

  it('runs a read', async () => {
    const [row] = await db.runReadOnly('RETURN 1 AS one');
    expect(Number(row.one)).toBe(1);
  });
});
