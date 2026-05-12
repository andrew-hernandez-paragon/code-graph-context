/**
 * Query Signals Outcome Tool — feedback loop for query_signals ranking.
 *
 * Records which results from a prior query_signals call were actually cited by
 * the consumer. Each citation is stored as a QueryOutcome node and linked to
 * the underlying cited node via a [:CITED] edge.
 *
 * QueryOutcome is a PRESERVED_LABELS node — it survives project reparses so
 * ranking-feedback data accumulates over time.
 *
 * 0010 — v1 scope:
 *   - Explicit callback only; no auto-detection of citations.
 *   - Single projectId per outcome (multi-projectId queries should use the
 *     result's own projectId).
 *   - Idempotent: MERGE on (queryId, citedResultId) prevents double-emission.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ensureProjectNode, isSyntheticProjectId } from '../../core/utils/project-id.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { autoResolveProjectId, createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

// ---------------------------------------------------------------------------
// Cypher
// ---------------------------------------------------------------------------

/**
 * Idempotent MERGE on (queryId, citedResultId). Sets all properties on first
 * create, then attempts to wire a [:CITED] edge to the referenced node if it
 * exists in the graph.
 *
 * The CITED edge is best-effort — if the node was deleted by a reparse the
 * QueryOutcome node is still created without a dangling reference.
 */
const MERGE_QUERY_OUTCOME = `
  MERGE (qo:QueryOutcome {queryId: $queryId, citedResultId: $citedResultId})
  ON CREATE SET
    qo.id            = $id,
    qo.projectId     = $projectId,
    qo.citedSource   = $citedSource,
    qo.citedSourceRank = $citedSourceRank,
    qo.agentId       = $agentId,
    qo.citationKind  = $citationKind,
    qo.ts            = timestamp()

  WITH qo
  OPTIONAL MATCH (target)
  WHERE target.id = $citedResultId
  WITH qo, target
  FOREACH (_ IN CASE WHEN target IS NOT NULL THEN [1] ELSE [] END |
    MERGE (qo)-[:CITED]->(target)
  )

  RETURN qo.id AS id, (target IS NOT NULL) AS linkedToNode
`;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const createQuerySignalsOutcomeTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.querySignalsOutcome,
    {
      title: TOOL_METADATA[TOOL_NAMES.querySignalsOutcome].title,
      description: TOOL_METADATA[TOOL_NAMES.querySignalsOutcome].description,
      inputSchema: {
        queryId: z
          .string()
          .describe('The queryId returned by the originating query_signals call'),
        citedResults: z
          .array(
            z.object({
              resultId: z
                .string()
                .describe('The id of the cited result (nodeId for code; note/pheromone id for other sources)'),
              source: z
                .enum(['code', 'notes', 'pheromones', 'toolcalls', 'commits'])
                .describe('Which query_signals source section this result came from'),
              sourceRank: z
                .number()
                .int()
                .min(1)
                .describe('1-based position of the result within its source section'),
              citationKind: z
                .enum(['direct', 'paraphrase', 'background'])
                .optional()
                .describe("How the result was used: 'direct' (quoted), 'paraphrase' (restated), 'background' (influenced reasoning)"),
            }),
          )
          .min(1)
          .max(50)
          .describe('One or more results from the query_signals response that were cited'),
        agentId: z.string().optional().describe('Agent ID of the consumer that cited these results'),
        projectId: z
          .string()
          .optional()
          .describe(
            'Project ID, name, or path. Falls back to auto-resolve if only one project exists. For multi-project queries use the cited result\'s own projectId.',
          ),
      },
    },
    async ({ queryId, citedResults, agentId, projectId }) => {
      const neo4jService = new Neo4jService();
      try {
        const projectResult = await autoResolveProjectId(projectId, neo4jService);
        if (!projectResult.success) {
          return projectResult.error;
        }
        const resolvedProjectId = projectResult.projectId;

        await ensureProjectNode(neo4jService, resolvedProjectId, {
          synthetic: isSyntheticProjectId(resolvedProjectId),
        });

        let outcomesRecorded = 0;
        let linkedCount = 0;

        for (const cited of citedResults) {
          const id = `qo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const rows = await neo4jService.run(MERGE_QUERY_OUTCOME, {
            id,
            queryId,
            citedResultId: cited.resultId,
            projectId: resolvedProjectId,
            citedSource: cited.source,
            citedSourceRank: cited.sourceRank,
            agentId: agentId ?? null,
            citationKind: cited.citationKind ?? null,
          });

          outcomesRecorded++;
          if (rows[0]?.linkedToNode) {
            linkedCount++;
          }
        }

        return createSuccessResponse(
          JSON.stringify(
            {
              outcomesRecorded,
              linkedToNode: linkedCount,
              queryId,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await debugLog('Query signals outcome error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
