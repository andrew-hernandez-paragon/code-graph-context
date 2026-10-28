import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEmbeddingDimensions, getEmbeddingModel } from '../../core/embeddings/embedding-config.js';
import {
  SAMPLE_EMBEDDED_NODE_CYPHER,
  SELECT_UNSTAMPED_CODEBASES_QUERY,
  describeEmbeddingMismatch,
} from '../../core/projects/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';

// Opt in against a local Neo4j instance. Only reads run here: the backfill's write never does.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('Embedding stamp backfill selection in Neo4j', () => {
  let db: Neo4jService;
  beforeAll(() => {
    db = new Neo4jService();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('reads each codebase vector size, matches its stamp, and flags only a model other than the configured one', async () => {
    const rows = await db.runReadOnly(
      `MATCH (p:Project) WHERE p.kind = 'codebase' ${SAMPLE_EMBEDDED_NODE_CYPHER}
       RETURN p.projectId AS projectId, p.name AS name, p.embeddingDimensions AS stamped, dimensions, model`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const configured = { model: getEmbeddingModel(), dimensions: getEmbeddingDimensions() };
    for (const row of rows) {
      const dimensions = Number(row.dimensions);
      expect(dimensions).toBeGreaterThan(0);
      if (row.stamped != null) expect(Number(row.stamped)).toBe(dimensions);
      const warning = describeEmbeddingMismatch(
        {
          projectId: row.projectId,
          name: row.name,
          embeddingModel: row.model ?? null,
          embeddingDimensions: dimensions,
        },
        configured,
      );
      if (dimensions === configured.dimensions && (row.model == null || row.model === configured.model)) {
        expect(warning).toBeNull();
      } else {
        expect(warning).toContain(`${dimensions} dimensions`);
      }
    }
  });

  it('selects only codebases without a stamp, each with a positive vector size', async () => {
    const rows = await db.runReadOnly(SELECT_UNSTAMPED_CODEBASES_QUERY);
    const stamped = await db.runReadOnly(
      'MATCH (p:Project) WHERE p.embeddingDimensions IS NOT NULL RETURN p.projectId AS projectId',
    );
    const stampedIds = new Set(stamped.map((row) => row.projectId));

    for (const row of rows) {
      expect(stampedIds.has(row.projectId)).toBe(false);
      expect(Number(row.dimensions)).toBeGreaterThan(0);
    }
  });
});
