import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { searchCodeRaw } from '../../../mcp/handlers/query-signals.handler.js';
import { Neo4jService, QUERIES } from '../neo4j.service.js';
import { VECTOR_INDEXES } from '../vector-indexes.js';

// Opt in against a local Neo4j whose vector indexes have been rebuilt with the projectId filter.
// READ transactions only; a filtered SEARCH is a read. A missing filter property fails only at run time (22ND3).
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('project-filtered vector search in Neo4j', () => {
  let db: Neo4jService;
  let sample: { projectId: string; embedding: number[]; coreType: string };

  beforeAll(async () => {
    db = new Neo4jService();
    const run = db.run.bind(db);
    db.run = async (query, params = {}) => {
      const session = db.getDriver().session({ defaultAccessMode: 'READ' });
      try {
        const result = await session.executeRead((tx) => tx.run(query, params), { timeout: 30000 });
        return result.records.map((record) => record.toObject());
      } finally {
        await session.close();
      }
    };
    // Vectors of another size are left out of the index, so sample only nodes the index can serve.
    const [index] = await run(
      `SHOW VECTOR INDEXES YIELD name, options WHERE name = $name
       RETURN options.indexConfig.\`vector.dimensions\` AS dimensions`,
      { name: VECTOR_INDEXES.embeddedNodes.name },
    );
    // The smallest project is the case the filter exists for, and its per-node duplicate search finishes quickly.
    const rows = await run(
      `MATCH (n:Embedded) WHERE n.coreType IS NOT NULL AND size(n.embedding) = $dimensions
       WITH n.projectId AS projectId, count(*) AS embeddedNodes
       ORDER BY embeddedNodes ASC LIMIT 1
       MATCH (n:Embedded {projectId: projectId}) WHERE n.coreType IS NOT NULL AND size(n.embedding) = $dimensions
       RETURN projectId, n.embedding AS embedding, n.coreType AS coreType LIMIT 1`,
      { dimensions: index.dimensions },
    );
    sample = rows[0] as typeof sample;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('searchCodeRaw returns rows from the requested project only', async () => {
    const rows = await searchCodeRaw(db, {
      projectIds: [sample.projectId],
      embedding: sample.embedding,
      limit: 5,
      minSimilarity: 0.3,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([sample.projectId]));
  });

  it('searchCodeRaw returns nothing for a project with no embeddings', async () => {
    const rows = await searchCodeRaw(db, {
      projectIds: ['proj_cgc_no_such_project'],
      embedding: sample.embedding,
      limit: 5,
      minSimilarity: 0.3,
    });
    expect(rows).toEqual([]);
  });

  it('FIND_SEMANTIC_DUPLICATES pairs nodes of the requested project only', async () => {
    const rows = await db.run(QUERIES.FIND_SEMANTIC_DUPLICATES, {
      projectId: sample.projectId,
      coreTypes: [sample.coreType],
      minSimilarity: 0.5,
      vectorNeighbors: 10,
      limit: 5,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.nodeId1).startsWith(`${sample.projectId}:`)).toBe(true);
      expect(String(row.nodeId2).startsWith(`${sample.projectId}:`)).toBe(true);
    }
  });
});
