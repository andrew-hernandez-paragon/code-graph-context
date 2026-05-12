/**
 * One-shot backfill script: ensures a Project node exists for every projectId
 * referenced by any node in the graph that does not already have one.
 *
 * Safe to re-run — MERGE is idempotent.
 * Run out-of-band (not as an auto-startup task) to avoid lock contention.
 *
 * Usage:
 *   npm run backfill:projects
 */

import 'dotenv/config';

import { CANONICAL_PROJECT_ID_RE, ENSURE_PROJECT_NODE_QUERY } from '../src/core/utils/project-id.js';
import { Neo4jService } from '../src/storage/neo4j/neo4j.service.js';

const FIND_MISSING_PROJECTS_QUERY = `
  MATCH (n)
  WHERE n.projectId IS NOT NULL
  WITH DISTINCT n.projectId AS pid
  OPTIONAL MATCH (p:Project { projectId: pid })
  WITH pid, p
  WHERE p IS NULL
  RETURN pid
`;

const main = async (): Promise<void> => {
  const neo4jService = new Neo4jService();

  try {
    console.log('Scanning for projectIds without Project nodes...');

    const missing = await neo4jService.run(FIND_MISSING_PROJECTS_QUERY, {});

    if (missing.length === 0) {
      console.log('All projectIds already have Project nodes. Nothing to do.');
      return;
    }

    console.log(`Found ${missing.length} projectId(s) without Project nodes. Creating...`);

    let created = 0;
    for (const row of missing) {
      const pid = row.pid as string;
      const synthetic = !CANONICAL_PROJECT_ID_RE.test(pid);

      await neo4jService.run(ENSURE_PROJECT_NODE_QUERY, {
        projectId: pid,
        name: pid,
        path: null,
        synthetic,
        status: synthetic ? 'synthetic' : null,
      });

      console.log(`  Created Project node: ${pid} (synthetic=${synthetic})`);
      created++;
    }

    console.log(`Done. Created ${created} Project node(s).`);
  } finally {
    await neo4jService.close();
  }
};

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
