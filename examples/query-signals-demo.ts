/**
 * Runnable demo for the unified query_signals MCP handler.
 *
 * Connects to local Neo4j, calls runQuerySignals() against an existing parsed
 * project, prints the sectioned response, and asserts the response shape.
 *
 * Run:
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=<pw> \
 *     npx tsx examples/query-signals-demo.ts [projectId-or-name] [query]
 *
 * Defaults:
 *   projectId: claude-code   (proj_36cffc3751ec)
 *   query:    "webhook signing verification"
 *
 * Embedding behavior:
 *   - Vector sources (code, notes) need an embedding for the query.
 *   - If the embedding provider is unavailable, the demo falls back to
 *     pheromones-only mode which still proves the sectioned response
 *     shape, parallel fan-out, latency tracking, and graceful per-source skip.
 *   - The 0008 fast-fail probe is used — no 120s startup wedge.
 */

import 'dotenv/config';

import { resolveProjectIdFromInput } from '../src/core/utils/project-id.js';
import { probeEmbeddingsHealth } from '../src/mcp/handlers/query-signals.handler.js';
import { runQuerySignals } from '../src/mcp/tools/query-signals.tool.js';
import { Neo4jService } from '../src/storage/neo4j/neo4j.service.js';

const projectIdArg = process.argv[2] ?? 'claude-code';
const queryArg = process.argv[3] ?? 'webhook signing verification';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exitCode = 1;
  }
};

const main = async (): Promise<void> => {
  const neo4j = new Neo4jService();
  const seededPheromoneIds: string[] = [];
  try {
    const projectId = await resolveProjectIdFromInput(projectIdArg, neo4j);
    console.log(`Resolved projectId: ${projectId}`);
    console.log(`Query: ${queryArg}`);

    // 0008 fast-fail probe — avoids triggering the 120s sidecar auto-start.
    const embeddingsWork = await probeEmbeddingsHealth(1000);
    const sources: ('code' | 'notes' | 'pheromones')[] = embeddingsWork
      ? ['code', 'notes', 'pheromones']
      : ['pheromones'];
    console.log(
      embeddingsWork
        ? 'Embeddings available → running ALL sources (code + notes + pheromones)'
        : 'Embeddings unavailable → running pheromones-only mode (structural proof)',
    );

    // Seed two transient pheromones so the pheromones source has data to return.
    const now = Date.now();
    const seedRows = await neo4j.run(
      `UNWIND $seeds AS s
       CREATE (p:Pheromone {
         id: s.id,
         projectId: $projectId,
         nodeId: s.nodeId,
         type: s.type,
         intensity: s.intensity,
         agentId: 'demo-prototype',
         swarmId: 'demo-0002',
         sessionId: 'demo-session',
         timestamp: s.timestamp,
         halfLife: 60000,
         data: s.data
       })
       RETURN p.id AS id`,
      {
        projectId,
        seeds: [
          {
            id: `demo-pher-warning-${now}`,
            nodeId: 'demo-node-1',
            type: 'warning',
            intensity: 0.95,
            timestamp: now,
            data: JSON.stringify({ note: 'demo: webhook signing — verify path silently 401s' }),
          },
          {
            id: `demo-pher-needs-review-${now}`,
            nodeId: 'demo-node-2',
            type: 'needs_review',
            intensity: 0.85,
            timestamp: now,
            data: JSON.stringify({ note: 'demo: needs review' }),
          },
        ],
      },
    );
    for (const row of seedRows) seededPheromoneIds.push(row.id as string);
    console.log(`Seeded ${seededPheromoneIds.length} transient pheromones`);
    console.log('---');

    // --- Test 1: single-project, all-sources ---
    const t0 = Date.now();
    const response = await runQuerySignals(neo4j, {
      projectIds: [projectId],
      query: queryArg,
      sources,
      limitPerSource: 3,
      minSimilarity: 0.35,
    });
    const wallMs = Date.now() - t0;

    console.log(JSON.stringify(response, null, 2));
    console.log('---');

    if ('sources' in response) {
      console.log(
        `wall=${wallMs}ms  total=${response.stats.totalLatencyMs}ms  ` +
          `code=${response.stats.sourceLatencyMs.code}ms  ` +
          `notes=${response.stats.sourceLatencyMs.notes}ms  ` +
          `pheromones=${response.stats.sourceLatencyMs.pheromones}ms`,
      );
      console.log(
        `counts: code=${response.sources.code.count} ` +
          `notes=${response.sources.notes.count} ` +
          `pheromones=${response.sources.pheromones.count}`,
      );

      assert(Array.isArray(response.projectIds), 'response.projectIds is array');
      assert(response.query === queryArg, 'response.query echoed');
      assert(response.sources && typeof response.sources === 'object', 'sources object present');
      assert(typeof response.sources.code.count === 'number', 'code.count is number');
      assert(typeof response.sources.notes.count === 'number', 'notes.count is number');
      assert(typeof response.sources.pheromones.count === 'number', 'pheromones.count is number');
      assert(Array.isArray(response.sources.code.results), 'code.results is array');
      assert(Array.isArray(response.sources.notes.results), 'notes.results is array');
      assert(Array.isArray(response.sources.pheromones.results), 'pheromones.results is array');
      assert(typeof response.stats.totalLatencyMs === 'number', 'totalLatencyMs is number');
    }

    // --- Test 2: sources filter ---
    console.log('---');
    const filterSources: ('code' | 'notes' | 'pheromones')[] = embeddingsWork ? ['code'] : ['pheromones'];
    console.log(`Testing sources filter: ${filterSources.join(',')}-only...`);
    const filtered = await runQuerySignals(neo4j, {
      projectIds: [projectId],
      query: queryArg,
      sources: filterSources,
      limitPerSource: 2,
      minSimilarity: 0.35,
    });
    if ('sources' in filtered) {
      for (const s of ['code', 'notes', 'pheromones'] as const) {
        if (!filterSources.includes(s)) {
          assert(filtered.sources[s].count === 0, `${s} empty when not in sources`);
          assert(filtered.stats.sourceLatencyMs[s] === null, `${s} latency null when skipped`);
        }
      }
      console.log(
        `filter-test: code=${filtered.sources.code.count} ` +
          `notes=${filtered.sources.notes.count} ` +
          `pheromones=${filtered.sources.pheromones.count}`,
      );
    }

    // --- Test 3: since annotation ---
    console.log('---');
    console.log('Testing since annotation (pheromones only + since)...');
    const withSince = await runQuerySignals(neo4j, {
      projectIds: [projectId],
      query: queryArg,
      sources: ['pheromones'],
      since: '30d',
      limitPerSource: 2,
      minSimilarity: 0.35,
    });
    if ('sources' in withSince) {
      assert(
        withSince.sources.pheromones.skipped === 'time-filter-not-applicable',
        'pheromones section annotated when since provided',
      );
      console.log(`since-test: pheromones.skipped=${withSince.sources.pheromones.skipped}`);
    }

    // --- Test 4: groupBy:'project' ---
    console.log('---');
    console.log('Testing groupBy:project...');
    const byProject = await runQuerySignals(neo4j, {
      projectIds: [projectId],
      query: queryArg,
      sources: ['pheromones'],
      limitPerSource: 2,
      groupBy: 'project',
    });
    assert('projects' in byProject, 'groupBy:project returns projects key');
    if ('projects' in byProject) {
      assert(byProject.projects[projectId] !== undefined, 'project bucket present for resolved projectId');
      console.log(`groupBy-test: project bucket keys=${Object.keys(byProject.projects).join(',')}`);
    }

    console.log('---');
    if (process.exitCode) {
      console.log('FAILED');
    } else {
      console.log('OK — all assertions pass');
    }
  } catch (err) {
    console.error('Demo errored:', err);
    process.exitCode = 2;
  } finally {
    if (seededPheromoneIds.length > 0) {
      try {
        await neo4j.run(`MATCH (p:Pheromone) WHERE p.id IN $ids DETACH DELETE p`, {
          ids: seededPheromoneIds,
        });
        console.log(`Cleaned up ${seededPheromoneIds.length} seed pheromones`);
      } catch (e) {
        console.error('Cleanup failed:', e);
      }
    }
    await neo4j.close();
  }
};

void main();
