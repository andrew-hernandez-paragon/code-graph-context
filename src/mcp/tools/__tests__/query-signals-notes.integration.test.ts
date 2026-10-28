import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Neo4jService } from '../../../storage/neo4j/neo4j.service.js';
import { runQuerySignals } from '../query-signals.tool.js';

// Opt in against a local Neo4j with the projectId-filtered indexes and the local embedder.
// Every statement runs in a READ transaction, which rejects writes.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('query_signals notes source in Neo4j', () => {
  let db: Neo4jService;
  let sample: { projectId: string; topic: string };

  beforeAll(async () => {
    db = new Neo4jService();
    db.run = async (query, params = {}) => {
      const session = db.getDriver().session({ defaultAccessMode: 'READ' });
      try {
        const result = await session.executeRead((tx) => tx.run(query, params), { timeout: 60000 });
        return result.records.map((record) => record.toObject());
      } finally {
        await session.close();
      }
    };
    const rows = await db.run(
      `MATCH (n:SessionNote) WHERE n.supersededBy IS NULL AND n.topic IS NOT NULL AND n.embedding IS NOT NULL
         AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
       RETURN n.projectId AS projectId, n.topic AS topic LIMIT 1`,
    );
    sample = rows[0] as typeof sample;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('returns notes of the requested project only, grouped by project', async () => {
    const response = await runQuerySignals(db, {
      projectIds: [sample.projectId],
      query: sample.topic,
      sources: ['notes'],
      minSimilarity: 0.3,
      groupBy: 'project',
    });
    if (!('projects' in response)) throw new Error('expected a grouped response');
    const notes = response.projects[sample.projectId].sources.notes;
    expect(notes.count).toBeGreaterThan(0);
    expect(new Set(notes.results.map((note) => note.projectId))).toEqual(new Set([sample.projectId]));
  });

  it('returns no notes for a project that has none', async () => {
    const response = await runQuerySignals(db, {
      projectIds: ['proj_cgc_no_such_project'],
      query: sample.topic,
      sources: ['notes'],
      minSimilarity: 0.1,
    });
    if (!('sources' in response)) throw new Error('expected a source response');
    expect(response.sources.notes.count).toBe(0);
  });
});
