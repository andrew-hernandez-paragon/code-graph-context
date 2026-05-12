/**
 * ingest_cursordiff_session MCP tool
 *
 * Two modes:
 *  - one-shot: read all cursordiff JSONL rows currently on disk, run MERGEs,
 *    return a summary.
 *  - watch:    start a @parcel/watcher subscription on the three JSONL files;
 *    return {watchId, paths, started} immediately; the watcher runs for the
 *    lifetime of the MCP server.
 */

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { planIngest } from '../../ingestors/cursordiff/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { cursordiffWatchManager, DEFAULT_DATA_DIR } from '../services/cursordiff-watch-manager.js';
import { createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

const inputSchema = z.object({
  mode: z.enum(['one-shot', 'watch']).describe('one-shot ingests current files; watch starts live tail'),
  dataDir: z
    .string()
    .optional()
    .describe(`Directory containing cursordiff JSONL files (default: ${DEFAULT_DATA_DIR})`),
  routerFile: z.string().optional().default('router.jsonl').describe('Router JSONL filename'),
  lineageFile: z.string().optional().default('lineage.jsonl').describe('Lineage JSONL filename'),
  decisionsFile: z.string().optional().default('decisions.jsonl').describe('Decisions JSONL filename'),
  parsedRoots: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Resolved project roots for projectId attribution'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, plan but do not write to Neo4j (one-shot returns plan stats; watch logs only)'),
  tailOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('watch mode only — skip existing rows and only process new writes'),
});

const resolveDataDir = (raw?: string): string => {
  if (!raw) return DEFAULT_DATA_DIR;
  return resolvePath(raw.replace(/^~/, homedir()));
};

export const createIngestCursordiffSessionTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.ingestCursordiffSession,
    {
      title: TOOL_METADATA[TOOL_NAMES.ingestCursordiffSession].title,
      description: TOOL_METADATA[TOOL_NAMES.ingestCursordiffSession].description,
      inputSchema: inputSchema.shape,
    },
    async (args: z.infer<typeof inputSchema>) => {
      try {
        const dataDir = resolveDataDir(args.dataDir);
        const { routerFile, lineageFile, decisionsFile, parsedRoots, dryRun, tailOnly } = args;

        await debugLog('ingest_cursordiff_session called', { mode: args.mode, dataDir, dryRun });

        // Validate dataDir
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
          const { emits, stats } = planIngest({ dataDir, parsedRoots });

          if (dryRun) {
            const summary = {
              dryRun: true,
              routerRows: stats.routerRows,
              lineageRows: stats.lineageRows,
              decisionRows: stats.decisionRows,
              toolCallsMerged: stats.toolCalls,
              hunksMerged: stats.hunks,
              decisionsMerged: stats.decisions,
              touchedEdges: emits.filter((e) => e.comment?.startsWith('TOUCHED')).length,
              syntheticProjects: stats.syntheticProjects,
              cypherStatements: emits.length,
            };
            return createSuccessResponse(JSON.stringify(summary, null, 2));
          }

          const neo4j = new Neo4jService();
          try {
            for (const e of emits) {
              await neo4j.run(e.query, e.params as Record<string, unknown>);
            }
          } finally {
            await neo4j.close();
          }

          const summary = {
            dryRun: false,
            routerRows: stats.routerRows,
            lineageRows: stats.lineageRows,
            decisionRows: stats.decisionRows,
            toolCallsMerged: stats.toolCalls,
            hunksMerged: stats.hunks,
            decisionsMerged: stats.decisions,
            touchedEdges: emits.filter((e) => e.comment?.startsWith('TOUCHED')).length,
            syntheticProjects: stats.syntheticProjects,
          };

          await debugLog('one-shot ingest complete', summary);
          return createSuccessResponse(JSON.stringify(summary, null, 2));
        }

        // ------------------------------------------------------------------ //
        // WATCH mode
        // ------------------------------------------------------------------ //
        const existing = cursordiffWatchManager.isWatching(dataDir);
        if (existing) {
          const info = {
            alreadyWatching: true,
            watchId: existing.watchId,
            dataDir: existing.dataDir,
            paths: [
              join(dataDir, existing.routerFile),
              join(dataDir, existing.lineageFile),
              join(dataDir, existing.decisionsFile),
            ],
            lastActivityAt: existing.lastActivityAt?.toISOString() ?? null,
            rowsProcessed: existing.rowsProcessed,
          };
          return createSuccessResponse(JSON.stringify(info, null, 2));
        }

        const rec = await cursordiffWatchManager.startWatching({
          dataDir,
          routerFile,
          lineageFile,
          decisionsFile,
          parsedRoots,
          dryRun,
          tailOnly,
        });

        const result = {
          started: true,
          watchId: rec.watchId,
          dataDir,
          paths: [join(dataDir, routerFile), join(dataDir, lineageFile), join(dataDir, decisionsFile)],
          tailOnly,
          dryRun,
        };

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('ingest_cursordiff_session error:', error);
        await debugLog('ingest_cursordiff_session error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
