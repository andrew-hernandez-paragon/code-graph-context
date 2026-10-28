/**
 * ingest_deliberate_session MCP tool
 *
 * Two modes:
 *  - one-shot: read all deliberation.jsonl rows currently on disk, run MERGEs,
 *    return a summary.
 *  - watch:    start a @parcel/watcher subscription on deliberation.jsonl;
 *    return {watchId, paths, started} immediately; the watcher runs for the
 *    lifetime of the MCP server.
 */

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ProjectService } from '../../core/projects/index.js';
import { planIngestDeliberate } from '../../ingestors/deliberate/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { deliberateWatchManager, DEFAULT_DELIBERATE_DATA_DIR } from '../services/deliberate-watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  mode: z.enum(['one-shot', 'watch']).describe('one-shot ingests current files; watch starts live tail'),
  dataDir: z
    .string()
    .optional()
    .describe(`Directory containing deliberation.jsonl (default: ${DEFAULT_DELIBERATE_DATA_DIR})`),
  deliberationFile: z.string().optional().default('deliberation.jsonl').describe('Deliberation JSONL filename'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, plan but do not write to Neo4j (one-shot returns plan stats; watch logs only)'),
  tailOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('watch mode only; skip existing rows and only process new writes'),
});

const resolveDataDir = (raw?: string): string => {
  if (!raw) return DEFAULT_DELIBERATE_DATA_DIR;
  return resolvePath(raw.replace(/^~/, homedir()));
};

export const createIngestDeliberateSessionTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.ingestDeliberateSession,
    {
      title: TOOL_METADATA[TOOL_NAMES.ingestDeliberateSession].title,
      description: TOOL_METADATA[TOOL_NAMES.ingestDeliberateSession].description,
      annotations: TOOL_METADATA[TOOL_NAMES.ingestDeliberateSession].annotations,
      inputSchema: inputSchema.shape,
    },
    async (args: z.infer<typeof inputSchema>) => {
      try {
        const dataDir = resolveDataDir(args.dataDir);
        const { deliberationFile, dryRun, tailOnly } = args;

        await debugLog('ingest_deliberate_session called', { mode: args.mode, dataDir, dryRun });

        if (!existsSync(dataDir)) {
          return createErrorResponse(new Error(`dataDir not found: ${dataDir}`));
        }
        if (!statSync(dataDir).isDirectory()) {
          return createErrorResponse(new Error(`dataDir is not a directory: ${dataDir}`));
        }

        // ------------------------------------------------------------------ //
        // ONE-SHOT mode
        // ------------------------------------------------------------------ //
        if (args.mode === 'one-shot') {
          const { emits, projectIds, stats } = planIngestDeliberate({ dataDir });

          const neo4j = new Neo4jService();
          try {
            // SCOPED_TO edges to an unregistered project are silently skipped, so name the ids.
            const unknownProjectIds = await new ProjectService(neo4j).findUnregisteredIds(projectIds);
            const summary = {
              dryRun,
              eventRows: stats.eventRows,
              deliberations: stats.deliberations,
              positions: stats.positions,
              verdicts: stats.verdicts,
              scopedToEdges: stats.scopedToEdges,
              aboutEdges: stats.aboutEdges,
              unknownProjectIds,
              ...(dryRun && { cypherStatements: emits.length }),
            };
            if (dryRun) {
              return createSuccessResponse(JSON.stringify(summary, null, 2));
            }

            for (const e of emits) {
              await neo4j.run(e.query, e.params as Record<string, unknown>);
            }

            await debugLog('one-shot deliberate ingest complete', summary);
            return createSuccessResponse(JSON.stringify(summary, null, 2));
          } finally {
            await neo4j.close();
          }
        }

        // ------------------------------------------------------------------ //
        // WATCH mode
        // ------------------------------------------------------------------ //
        const existing = deliberateWatchManager.isWatching(dataDir);
        if (existing) {
          const info = {
            alreadyWatching: true,
            watchId: existing.watchId,
            dataDir: existing.dataDir,
            paths: [join(dataDir, existing.deliberationFile)],
            lastActivityAt: existing.lastActivityAt?.toISOString() ?? null,
            rowsProcessed: existing.rowsProcessed,
          };
          return createSuccessResponse(JSON.stringify(info, null, 2));
        }

        const rec = await deliberateWatchManager.startWatching({
          dataDir,
          deliberationFile,
          dryRun,
          tailOnly,
        });

        const result = {
          started: true,
          watchId: rec.watchId,
          dataDir,
          paths: [join(dataDir, deliberationFile)],
          tailOnly,
          dryRun,
        };

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('ingest_deliberate_session error:', error);
        await debugLog('ingest_deliberate_session error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
