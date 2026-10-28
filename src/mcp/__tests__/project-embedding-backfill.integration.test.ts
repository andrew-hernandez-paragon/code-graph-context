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

  // proj_d7b9bff20766 is cursordiff-orchestrator, whose code holds 1024-dimension CodeSage vectors.
  it('reads the vector size of a project embedded with another model, and the comparison flags it', async () => {
    const rows = await db.runReadOnly(
      `MATCH (p:Project {projectId: $projectId}) ${SAMPLE_EMBEDDED_NODE_CYPHER} RETURN p.name AS name, dimensions, model`,
      { projectId: 'proj_d7b9bff20766' },
    );

    expect(rows).toHaveLength(1);
    const dimensions = Number(rows[0].dimensions);
    expect(dimensions).toBe(1024);
    expect(
      describeEmbeddingMismatch(
        {
          projectId: 'proj_d7b9bff20766',
          name: rows[0].name,
          embeddingModel: rows[0].model ?? null,
          embeddingDimensions: dimensions,
        },
        { model: getEmbeddingModel(), dimensions: getEmbeddingDimensions() },
      ),
    ).toContain('1024 dimensions');
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
