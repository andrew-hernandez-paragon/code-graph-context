import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jService, QUERIES } from '../neo4j.service.js';

// Opt in against a local Neo4j instance. READ transactions reject database writes.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('weighted scoring in Neo4j', () => {
  let db: Neo4jService;
  beforeAll(() => {
    db = new Neo4jService();
  });
  afterAll(async () => {
    await db?.close();
  });

  const productionQuery = QUERIES.EXPLORE_DEPTH_LEVEL();
  const statusProjection = productionQuery.match(/CASE[\s\S]*?END AS embeddingStatus/)![0];
  const similarityProjection = productionQuery.match(
    /CASE\s+WHEN embeddingStatus = 'compatible'[\s\S]*?END AS nodeSimilarity/,
  )![0];
  const vector = (dimensions: number) => [1, ...Array(dimensions - 1).fill(0)];

  it.each([
    { name: 'equal dimensions', neighbor: vector(768), query: vector(768), status: 'compatible', similarity: 1 },
    {
      name: 'mixed dimensions',
      neighbor: vector(1024),
      query: vector(768),
      status: 'dimension_mismatch',
      similarity: 0.5,
    },
    { name: 'missing neighbor vector', neighbor: null, query: vector(768), status: 'missing', similarity: 0.5 },
    { name: 'missing query vector', neighbor: vector(768), query: null, status: 'missing', similarity: 0.5 },
    { name: 'empty vectors', neighbor: [], query: [], status: 'zero_vector', similarity: 0.5 },
    { name: 'zero neighbor vector', neighbor: [0, 0], query: [1, 0], status: 'zero_vector', similarity: 0.5 },
    { name: 'zero query vector', neighbor: [1, 0], query: [0, 0], status: 'zero_vector', similarity: 0.5 },
  ])('$name returns a usable score without throwing', async ({ neighbor, query, status, similarity }) => {
    const session = db.getDriver().session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.executeRead(
        (tx) =>
          tx.run(
            `
        WITH {embedding: $neighborEmbedding} AS neighbor
        WITH neighbor, ${statusProjection}
        WITH embeddingStatus, neighbor, ${similarityProjection}
        RETURN embeddingStatus, nodeSimilarity
      `,
            { neighborEmbedding: neighbor, queryEmbedding: query },
          ),
        { timeout: 10000 },
      );
      expect(result.records[0].get('embeddingStatus')).toBe(status);
      expect(result.records[0].get('nodeSimilarity')).toBe(similarity);
    } finally {
      await session.close();
    }
  });
});
