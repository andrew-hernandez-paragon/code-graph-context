/**
 * Search Codebase Tool
 * Hybrid search over the code graph: vector embeddings and BM25, fused by
 * reciprocal rank, then a dependency traversal from the top result.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA, DEFAULTS } from '../constants.js';
import { searchCodeHybrid, type FusedSearchRow } from '../handlers/query-signals.handler.js';
import { searchMatchesOf, withSearchMatches } from '../handlers/search-matches.js';
import { TraversalHandler } from '../handlers/traversal.handler.js';
import {
  createEmptyResponse,
  createErrorResponse,
  debugLog,
  sanitizeNumericInput,
  resolveProjectIdOrError,
} from '../utils.js';

/**
 * Render the fused score plus whichever channel scores contributed, so a caller
 * can see whether a result came from meaning, from keywords, or from both.
 */
const formatFusedScore = (row: FusedSearchRow): string => {
  const parts = [`rrf: ${row.fusedScore.toFixed(4)}`];
  if (row.vectorScore !== null) parts.push(`vec: ${row.vectorScore.toFixed(3)}`);
  if (row.lexicalScore !== null) parts.push(`bm25: ${row.lexicalScore.toFixed(2)}`);
  return parts.join(', ');
};

export const createSearchCodebaseTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.searchCodebase,
    {
      title: TOOL_METADATA[TOOL_NAMES.searchCodebase].title,
      description: TOOL_METADATA[TOOL_NAMES.searchCodebase].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        query: z.string().describe('Natural language query to search the codebase'),
        maxDepth: z
          .number()
          .int()
          .optional()
          .describe('Maximum relationship traversal depth')
          .default(DEFAULTS.traversalDepth),
        maxNodesPerChain: z.number().int().optional().describe('Maximum chains to show per depth level').default(5),
        skip: z.number().int().optional().describe('Results to skip for pagination').default(0),
        includeCode: z.boolean().optional().describe('Include source code snippets in results').default(true),
        snippetLength: z
          .number()
          .int()
          .optional()
          .describe('Code snippet character limit')
          .default(DEFAULTS.codeSnippetLength),
        topK: z
          .number()
          .int()
          .optional()
          .describe('Number of top vector matches; best match is traversed, others shown as alternatives')
          .default(3),
        minSimilarity: z.number().optional().describe('Minimum similarity score threshold').default(0.65),
        useWeightedTraversal: z
          .boolean()
          .optional()
          .describe('Score each traversed node for relevance; higher quality but slower')
          .default(true),
      },
    },
    async ({
      projectId,
      query,
      maxDepth = DEFAULTS.traversalDepth,
      maxNodesPerChain = 5,
      skip = 0,
      includeCode = true,
      snippetLength = DEFAULTS.codeSnippetLength,
      topK = 3,
      minSimilarity = 0.65,
      useWeightedTraversal = true,
    }) => {
      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID from name, path, or ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        // Sanitize numeric inputs to ensure integers (Neo4j LIMIT requires integers)
        const sanitizedMaxDepth = sanitizeNumericInput(maxDepth, DEFAULTS.traversalDepth, 10);
        const sanitizedMaxNodesPerChain = sanitizeNumericInput(maxNodesPerChain, 5);
        const sanitizedSkip = sanitizeNumericInput(skip, 0);
        const sanitizedSnippetLength = sanitizeNumericInput(snippetLength, DEFAULTS.codeSnippetLength);
        const sanitizedTopK = sanitizeNumericInput(topK, 3, 10);

        const embeddingsService = new EmbeddingsService();
        const traversalHandler = new TraversalHandler(neo4jService);

        const embedding = await embeddingsService.embedText(query);

        // Hybrid: vector and BM25 in parallel, fused by reciprocal rank (0014).
        // minSimilarity still gates the vector channel only. A node the lexical
        // channel found is judged on its rank, because BM25 scores are unbounded
        // and have no comparable floor.
        const qualifiedResults = await searchCodeHybrid(neo4jService, {
          projectIds: [resolvedProjectId],
          query,
          embedding,
          limit: sanitizedTopK,
          minSimilarity,
          fetchMultiplier: 10,
        });

        if (qualifiedResults.length === 0) {
          return createEmptyResponse(
            `No code matched, by embedding similarity >= ${minSimilarity} or by keyword`,
            'Try rephrasing your query or lowering the minSimilarity threshold.',
          );
        }

        const matches = searchMatchesOf(qualifiedResults);
        // The traversal starts from the best match; the others are listed for traverse_from_node.
        const bestMatch = qualifiedResults[0];
        const nodeId = matches[0].id;
        const bestScore = formatFusedScore(bestMatch);

        const traversalResult = await traversalHandler.traverseFromNode(nodeId, embedding, {
          projectId: resolvedProjectId,
          maxDepth: sanitizedMaxDepth,
          direction: 'BOTH',
          includeCode,
          maxNodesPerChain: sanitizedMaxNodesPerChain,
          skip: sanitizedSkip,
          summaryOnly: false,
          snippetLength: sanitizedSnippetLength,
          title: `Search Results (${qualifiedResults.length} matches, best: ${bestScore}) - Traversing from: ${nodeId}`,
          useWeightedTraversal,
        });

        const first = traversalResult.content?.[0];
        if (first?.type === 'text') {
          first.text = withSearchMatches(first.text, matches);
        }

        return traversalResult;
      } catch (error) {
        console.error('Search codebase error:', error);
        await debugLog('Search codebase error', error);
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
