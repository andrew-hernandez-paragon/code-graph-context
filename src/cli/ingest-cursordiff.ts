/**
 * code-graph-context ingest-cursordiff — one-shot CLI ingestor that reads
 * the three cursordiff JSONL files and MERGEs ToolCall / Hunk / Decision
 * nodes (plus PRODUCED and RESOLVED_BY edges) into Neo4j.
 *
 * v1 scope (per proposal 0001-tool-call-decision-lineage):
 *   - One-shot CLI invocation, no fs-watch / live mode (deferred to v2).
 *   - Reads router.jsonl + lineage.jsonl + decisions.jsonl from
 *     --data-dir (default: ~/.local/share/nvim/cursordiff/).
 *   - Path-to-projectId via generateProjectId(); tags `synthetic: true`
 *     when the path isn't in a parsed project.
 *   - Idempotent: every write is a MERGE, so re-running over the same
 *     JSONL is a no-op.
 *   - `--dry-run` prints cypher + params instead of executing.
 *
 * Cut for v1:
 *   - No MCP tool wrapper (CLI only).
 *   - No (ToolCall)-[:TOUCHED]->(SourceFile) edge.
 *   - No fancy input/output digest beyond hash + length recorded on the
 *     cursordiff side.
 *
 * Run:
 *   npm run ingest:cursordiff -- --data-dir <path> --dry-run
 */

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';

import { planIngest } from '../ingestors/cursordiff/index.js';
import { Neo4jService } from '../storage/neo4j/neo4j.service.js';

interface CliOptions {
  dataDir: string;
  dryRun: boolean;
  parsedRoots: string[];
}

const parseArgs = (argv: string[]): CliOptions => {
  let dataDir = join(homedir(), '.local/share/nvim/cursordiff');
  let dryRun = false;
  const parsedRoots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') dataDir = resolvePath(argv[++i]!);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--parsed-root') parsedRoots.push(resolvePath(argv[++i]!));
  }
  return { dataDir, dryRun, parsedRoots };
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.dataDir)) {
    console.error(`ingest-cursordiff: data dir not found: ${opts.dataDir}`);
    process.exit(2);
  }
  if (!statSync(opts.dataDir).isDirectory()) {
    console.error(`ingest-cursordiff: not a directory: ${opts.dataDir}`);
    process.exit(2);
  }

  const { emits, stats } = planIngest(opts);

  if (opts.dryRun) {
    console.log('# ingest-cursordiff DRY RUN');
    console.log(`# data-dir: ${opts.dataDir}`);
    console.log(`# parsed-roots: ${opts.parsedRoots.length ? opts.parsedRoots.join(', ') : '(none)'}`);
    console.log(`# router rows:   ${stats.routerRows}`);
    console.log(`# lineage rows:  ${stats.lineageRows}`);
    console.log(`# decision rows: ${stats.decisionRows}`);
    console.log(`# → ToolCalls:   ${stats.toolCalls}`);
    console.log(`# → Hunks:       ${stats.hunks}`);
    console.log(`# → Decisions:   ${stats.decisions}`);
    console.log(`# → synthetic projectIds: ${stats.syntheticProjects}`);
    console.log(`# emit count: ${emits.length} cypher statements`);
    console.log('');
    for (const e of emits) {
      if (e.comment) console.log(`-- ${e.comment}`);
      console.log(e.query);
      console.log(`PARAMS = ${JSON.stringify(e.params)}`);
      console.log('');
    }
    return;
  }

  // Live mode: execute MERGE statements against Neo4j.
  const neo4j = new Neo4jService();
  try {
    let executed = 0;
    for (const e of emits) {
      await neo4j.run(e.query, e.params as Record<string, unknown>);
      executed++;
    }
    console.log(`ingest-cursordiff: executed ${executed} statements`);
    console.log(
      `  ToolCalls=${stats.toolCalls} Hunks=${stats.hunks} Decisions=${stats.decisions}` +
        ` (${stats.syntheticProjects} synthetic projects)`,
    );
  } finally {
    await neo4j.close();
  }
};

main().catch((err) => {
  console.error('ingest-cursordiff:', err);
  process.exit(1);
});
