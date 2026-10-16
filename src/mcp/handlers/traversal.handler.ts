/**
 * Traversal Handler
 * Handles graph traversal operations with formatting and pagination
 */

import path from 'path';

import { MAX_TRAVERSAL_DEPTH } from '../../constants.js';
import { Neo4jNode } from '../../core/config/schema.js';
import { getCommonRoot, normalizeFilePath, toRelativePath } from '../../core/utils/path-utils.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { DEFAULTS } from '../constants.js';
import { createErrorResponse, createSuccessResponse, debugLog, truncateCode } from '../utils.js';

export interface TraversalResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export interface TraversalOptions {
  projectId: string; // Required for project isolation
  maxDepth?: number;
  skip?: number;
  limit?: number; // Results per page for pagination
  direction?: 'OUTGOING' | 'INCOMING' | 'BOTH';
  relationshipTypes?: string[];
  includeStartNodeDetails?: boolean;
  includeCode?: boolean;
  maxNodesPerChain?: number;
  summaryOnly?: boolean;
  title?: string;
  snippetLength?: number;
  useWeightedTraversal?: boolean;
  maxTotalNodes?: number; // Limits total unique nodes to control output size
}

interface Connection {
  depth: number;
  node: Neo4jNode;
  relationshipChain?: Array<{ type: string }>;
}

interface TraversalData {
  connections: Connection[];
  graph?: any;
  embeddingFallbacks?: Record<string, number>;
}

export class TraversalHandler {
  private static readonly NODE_NOT_FOUND_QUERY = 'MATCH (n:GraphNode {id: $nodeId, projectId: $projectId}) RETURN n';
  private static readonly GET_NODE_BY_FILE_PATH_QUERY =
    'MATCH (sf:SourceFile {filePath: $filePath}) WHERE sf.projectId = $projectId RETURN sf.id AS nodeId LIMIT 1';
  // Relative paths match the entire suffix, never just their basename.
  private static readonly GET_NODE_BY_FILE_PATH_FUZZY_QUERY = `
    MATCH (sf:SourceFile)
    WHERE sf.projectId = $projectId
      AND (sf.filePath ENDS WITH $filePath OR sf.filePath = $relativePath)
    RETURN sf.id AS nodeId, sf.filePath AS filePath
    ORDER BY sf.filePath
    LIMIT 5
  `;

  constructor(private neo4jService: Neo4jService) {}

  /**
   * Resolves a file path to a SourceFile node ID
   * Tries exact match first, then fuzzy match by path ending or filename
   * @param filePath - The file path to look up (can be absolute, relative, or just filename)
   * @param projectId - The project ID to scope the search
   * @returns The node ID if found, null otherwise
   */
  async resolveNodeIdFromFilePath(filePath: string, projectId: string): Promise<string | null> {
    // Normalize the input path
    const normalizedInput = normalizeFilePath(filePath);

    // Try exact match first with normalized path
    const exactResult = await this.neo4jService.run(TraversalHandler.GET_NODE_BY_FILE_PATH_QUERY, {
      filePath: normalizedInput,
      projectId,
    });
    if (exactResult.length > 0) {
      return exactResult[0].nodeId;
    }

    if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return null;

    const pathForMatching = path.posix.normalize(filePath.replace(/\\/g, '/')).replace(/^\.\//, '');

    // Try fuzzy match
    const fuzzyResult = await this.neo4jService.run(TraversalHandler.GET_NODE_BY_FILE_PATH_FUZZY_QUERY, {
      filePath: '/' + pathForMatching,
      relativePath: pathForMatching,
      projectId,
    });

    if (fuzzyResult.length === 1) {
      // Single match - use it
      return fuzzyResult[0].nodeId;
    } else if (fuzzyResult.length > 1) {
      // Multiple matches - throw error to let caller provide better guidance
      await debugLog('Multiple file matches found', {
        searchPath: filePath,
        matches: fuzzyResult.map((r) => r.filePath),
      });
      const matchList = fuzzyResult.map((r) => `  - ${r.filePath}`).join('\n');
      throw new Error(
        `Ambiguous file path "${filePath}" matches multiple files:\n${matchList}\n\nPlease provide a more specific path.`,
      );
    }

    return null;
  }

  async traverseFromNode(nodeId: string, embedding: number[], options: TraversalOptions): Promise<TraversalResult> {
    const {
      projectId,
      maxDepth = DEFAULTS.traversalDepth,
      skip = DEFAULTS.skipOffset,
      limit = 50,
      direction = 'BOTH',
      relationshipTypes,
      includeStartNodeDetails = true,
      includeCode = false,
      maxNodesPerChain = 5,
      summaryOnly = false,
      title = `Node Traversal from: ${nodeId}`,
      snippetLength = DEFAULTS.codeSnippetLength,
      useWeightedTraversal = false,
      maxTotalNodes = 50,
    } = options;

    try {
      await debugLog('Starting node traversal', { nodeId, projectId, maxDepth, skip });

      const startNode = await this.getStartNode(nodeId, projectId);
      if (!startNode) {
        return createErrorResponse(`Node with ID "${nodeId}" not found in project "${projectId}".`);
      }

      const maxNodesPerDepth = Math.ceil(maxNodesPerChain * 1.5);
      const traversalData = useWeightedTraversal
        ? await this.performTraversalByDepth(
            nodeId,
            projectId,
            embedding,
            maxDepth,
            maxNodesPerDepth,
            direction,
            relationshipTypes,
          )
        : await this.performTraversal(nodeId, projectId, embedding, maxDepth, skip, direction, relationshipTypes);

      if (!traversalData) {
        return createSuccessResponse(`No connections found for node "${nodeId}".`);
      }

      const fallbackCount = Object.values(traversalData.embeddingFallbacks ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      );
      const diagnostics =
        fallbackCount > 0
          ? {
              ranking: { mode: 'weighted', embeddingFallbacks: traversalData.embeddingFallbacks },
              warnings: [
                `${fallbackCount} traversed nodes have incompatible embeddings and were ranked by relationship weight and depth. Verify current source; semantic relevance was unavailable for these nodes.`,
              ],
            }
          : {};

      let result = summaryOnly
        ? this.formatSummaryOnlyJSON(startNode, traversalData, title)
        : this.formatTraversalJSON(
            startNode,
            traversalData,
            title,
            includeStartNodeDetails,
            includeCode,
            maxNodesPerChain,
            snippetLength,
            maxTotalNodes,
            skip,
            limit,
          );

      // Auto-summarize if output is too large (>50KB)
      const MAX_OUTPUT_BYTES = 50000;
      Object.assign(result, diagnostics);
      let resultStr = JSON.stringify(result);
      if (!summaryOnly && resultStr.length > MAX_OUTPUT_BYTES) {
        await debugLog('Output too large, auto-summarizing', {
          originalSize: resultStr.length,
          maxSize: MAX_OUTPUT_BYTES,
        });
        result = this.formatSummaryOnlyJSON(startNode, traversalData, title);
        Object.assign(result, diagnostics);
        result.autoSummarized = true;
        result.originalSize = resultStr.length;
        resultStr = JSON.stringify(result);
      }

      await debugLog('Traversal completed', {
        connectionsFound: traversalData.connections.length,
        uniqueFiles: this.getUniqueFileCount(traversalData.connections),
        outputSize: resultStr.length,
      });

      return {
        content: [{ type: 'text', text: resultStr }],
      };
    } catch (error) {
      console.error('Node traversal error:', error);
      await debugLog('Node traversal error', { nodeId, error });
      return createErrorResponse(error);
    }
  }

  private async getStartNode(nodeId: string, projectId: string): Promise<Neo4jNode | null> {
    const startNodeResult = await this.neo4jService.run(TraversalHandler.NODE_NOT_FOUND_QUERY, { nodeId, projectId });

    return startNodeResult.length > 0 ? startNodeResult[0].n : null;
  }

  private async performTraversal(
    nodeId: string,
    projectId: string,
    embedding: number[],
    maxDepth: number,
    skip: number,
    direction: 'OUTGOING' | 'INCOMING' | 'BOTH' = 'BOTH',
    relationshipTypes?: string[],
  ): Promise<TraversalData | null> {
    const traversal = await this.neo4jService.run(
      QUERIES.EXPLORE_ALL_CONNECTIONS(Math.min(maxDepth, MAX_TRAVERSAL_DEPTH), direction, relationshipTypes),
      {
        nodeId,
        projectId,
        skip: parseInt(skip.toString()),
      },
    );

    await debugLog('Traversal query executed', {
      direction,
      maxDepth,
      nodeId,
      resultCount: traversal.length,
      connectionsCount: traversal[0]?.result?.connections?.length ?? 0,
    });

    if (traversal.length === 0) {
      return null;
    }

    const result = traversal[0]?.result ?? {};
    return {
      connections: result.connections ?? [],
      graph: result.graph ?? { nodes: [], relationships: [] },
    };
  }

  private async performTraversalByDepth(
    nodeId: string,
    projectId: string,
    embedding: number[],
    maxDepth: number,
    maxNodesPerDepth: number,
    direction: 'OUTGOING' | 'INCOMING' | 'BOTH' = 'BOTH',
    relationshipTypes?: string[],
  ): Promise<TraversalData> {
    // Track visited nodes to avoid cycles
    const visitedNodeIds = new Set<string>([nodeId]);

    // Track the path (chain of relationships) to reach each node
    // Key: nodeId, Value: array of relationships from start node to this node
    const pathsToNode = new Map<string, any[]>();
    pathsToNode.set(nodeId, []); // Start node has empty path

    // Track which nodes to explore at each depth
    let currentSourceIds = [nodeId];

    // Result accumulators
    const allConnections: Connection[] = [];
    const embeddingFallbacks: Record<string, number> = {};
    const nodeMap = new Map<string, Neo4jNode>(); // Dedupe nodes

    for (let depth = 1; depth <= maxDepth; depth++) {
      if (currentSourceIds.length === 0) {
        console.error(`No source nodes to explore at depth ${depth}`);
        break;
      }

      const traversalResults = await this.neo4jService.run(QUERIES.EXPLORE_DEPTH_LEVEL(direction, maxNodesPerDepth), {
        sourceNodeIds: currentSourceIds,
        visitedNodeIds: Array.from(visitedNodeIds),
        currentDepth: parseInt(depth.toString()),
        queryEmbedding: embedding,
        depthDecay: 0.85,
        projectId,
        relationshipTypes: relationshipTypes?.length ? relationshipTypes : null,
      });

      if (traversalResults.length === 0) {
        console.error(`No connections found at depth ${depth}`);
        break;
      }

      // Collect node IDs for next depth exploration
      const nextSourceIds: string[] = [];

      for (const row of traversalResults) {
        const { node, relationship, sourceNodeId, scoring } = row.result;
        const neighborId = node.id;

        // Skip if already visited (safety check)
        if (visitedNodeIds.has(neighborId)) continue;

        if (scoring.embeddingStatus === 'dimension_mismatch' || scoring.embeddingStatus === 'zero_vector') {
          embeddingFallbacks[scoring.embeddingStatus] = (embeddingFallbacks[scoring.embeddingStatus] ?? 0) + 1;
        }

        // Mark as visited
        visitedNodeIds.add(neighborId);
        nextSourceIds.push(neighborId);

        // Build the relationship chain:
        // This node's chain = parent's chain + this relationship
        const parentPath = pathsToNode.get(sourceNodeId) ?? [];
        const thisPath = [
          ...parentPath,
          {
            type: relationship.type,
            start: relationship.startNodeId,
            end: relationship.endNodeId,
            properties: relationship.properties,
            score: scoring.combinedScore,
          },
        ];
        pathsToNode.set(neighborId, thisPath);

        // Create connection with full relationship chain
        const connection: Connection = {
          depth,
          node: node as Neo4jNode,
          relationshipChain: thisPath,
        };
        allConnections.push(connection);

        // Accumulate unique nodes
        nodeMap.set(neighborId, node as Neo4jNode);
      }

      // Move to next depth with the newly discovered nodes
      currentSourceIds = nextSourceIds;
    }

    return {
      connections: allConnections,
      embeddingFallbacks,
    };
  }

  private groupConnectionsByDepth(connections: Connection[]): Record<number, Connection[]> {
    return connections.reduce(
      (acc, conn) => {
        const depth = conn.depth;
        acc[depth] ??= [];
        acc[depth].push(conn);
        return acc;
      },
      {} as Record<number, Connection[]>,
    );
  }

  private getRelationshipDirection(connection: Connection, startNodeId: string): 'OUTGOING' | 'INCOMING' | 'UNKNOWN' {
    // Check the first relationship in the chain to determine direction from start node
    const firstRel = connection.relationshipChain?.[0] as any;
    if (!firstRel?.start || !firstRel.end) {
      return 'UNKNOWN';
    }

    // If the start node is the source of the first relationship, it's OUTGOING
    // If the start node is the target of the first relationship, it's INCOMING
    if (firstRel.start === startNodeId) {
      return 'OUTGOING';
    } else if (firstRel.end === startNodeId) {
      return 'INCOMING';
    }

    return 'UNKNOWN';
  }

  private getUniqueFileCount(connections: Connection[]): number {
    return new Set(connections.map((c) => c.node.properties.filePath).filter(Boolean)).size;
  }

  private formatTraversalJSON(
    startNode: Neo4jNode,
    traversalData: { connections: Connection[]; graph?: any },
    title: string,
    includeStartNodeDetails: boolean,
    includeCode: boolean,
    maxNodesPerChain: number,
    snippetLength: number,
    maxTotalNodes: number = 50,
    skip: number = 0,
    limit: number = 50,
  ): any {
    // JSON:API normalization - collect all unique nodes
    const nodeMap = new Map<string, any>();

    // Get common root path from all nodes
    const allFilePaths = [startNode, ...traversalData.connections.map((c) => c.node)]
      .map((n) => n.properties.filePath)
      .filter(Boolean) as string[];
    const projectRoot = getCommonRoot(allFilePaths);

    // Add start node to map
    if (includeStartNodeDetails) {
      const startNodeData = this.formatNodeJSON(startNode, includeCode, snippetLength, projectRoot);
      nodeMap.set(startNode.properties.id, startNodeData);
    }

    // Collect all unique nodes from connections (limited by maxTotalNodes)
    let nodeCount = nodeMap.size;
    let truncatedNodes = 0;
    for (const conn of traversalData.connections) {
      const nodeId = conn.node.properties.id;
      if (!nodeMap.has(nodeId)) {
        if (nodeCount >= maxTotalNodes) {
          truncatedNodes++;
          continue;
        }
        nodeMap.set(nodeId, this.formatNodeJSON(conn.node, includeCode, snippetLength, projectRoot));
        nodeCount++;
      }
    }

    const byDepth = this.groupConnectionsByDepth(traversalData.connections);

    const totalConnections = traversalData.connections.length;

    return {
      projectRoot,
      totalConnections,
      uniqueFiles: this.getUniqueFileCount(traversalData.connections),
      maxDepth: Object.keys(byDepth).length > 0 ? Math.max(...Object.keys(byDepth).map((d) => parseInt(d))) : 0,
      startNodeId: includeStartNodeDetails ? startNode.properties.id : undefined,
      nodes: Object.fromEntries(nodeMap),
      depths: this.formatConnectionsByDepthWithReferences(byDepth, maxNodesPerChain),
      pagination: {
        skip,
        limit,
        returned: nodeMap.size,
        totalConnections,
        hasNextPage: skip + limit < totalConnections,
      },
      ...(truncatedNodes > 0 && { nodesTruncated: truncatedNodes }),
    };
  }

  private formatSummaryOnlyJSON(
    startNode: Neo4jNode,
    traversalData: { connections: Connection[]; graph?: any },
    title: string,
  ): any {
    const byDepth = this.groupConnectionsByDepth(traversalData.connections);
    const totalConnections = traversalData.connections.length;
    const maxDepthFound =
      Object.keys(byDepth).length > 0 ? Math.max(...Object.keys(byDepth).map((d) => parseInt(d))) : 0;
    const uniqueFiles = this.getUniqueFileCount(traversalData.connections);

    const allFilePaths = [startNode, ...traversalData.connections.map((c) => c.node)]
      .map((n) => n.properties.filePath)
      .filter(Boolean) as string[];
    const projectRoot = getCommonRoot(allFilePaths);

    const fileMap = new Map<string, number>();
    traversalData.connections.forEach((conn) => {
      const filePath = conn.node.properties.filePath;
      if (filePath) {
        const relativePath = toRelativePath(filePath, projectRoot);
        fileMap.set(relativePath, (fileMap.get(relativePath) ?? 0) + 1);
      }
    });

    const connectedFiles = Array.from(fileMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([file, count]) => ({ file, nodeCount: count }));

    const maxSummaryFiles = DEFAULTS.maxResultsDisplayed;

    return {
      projectRoot,
      startNodeId: startNode.properties.id,
      nodes: {
        [startNode.properties.id]: this.formatNodeJSON(startNode, false, 0, projectRoot),
      },
      totalConnections,
      maxDepth: maxDepthFound,
      uniqueFiles,
      files: connectedFiles.slice(0, maxSummaryFiles),
      ...(fileMap.size > maxSummaryFiles && { hasMore: fileMap.size - maxSummaryFiles }),
    };
  }

  private formatNodeJSON(node: Neo4jNode, includeCode: boolean, snippetLength: number, projectRoot?: string): any {
    const result: any = {
      id: node.properties.id,
      type: node.properties.semanticType ?? node.labels.at(-1) ?? 'Unknown',
      filePath: projectRoot ? toRelativePath(node.properties.filePath, projectRoot) : node.properties.filePath,
    };

    if (node.properties.name) {
      result.name = node.properties.name;
    }

    if (includeCode && node.properties.sourceCode && node.properties.coreType !== 'SourceFile') {
      const truncateResult = truncateCode(node.properties.sourceCode, snippetLength);
      result.sourceCode = truncateResult.text;
      if (truncateResult.hasMore) {
        result.hasMore = truncateResult.hasMore;
        result.truncated = truncateResult.truncated;
      }
    }

    return result;
  }

  private formatConnectionsByDepthWithReferences(
    byDepth: Record<number, Connection[]>,
    maxNodesPerChain: number,
  ): any[] {
    return Object.keys(byDepth)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((depth) => {
        const depthConnections = byDepth[parseInt(depth)];

        const connectionsToShow = Math.min(depthConnections.length, maxNodesPerChain);

        const chains = depthConnections.slice(0, connectionsToShow).map((conn) => {
          return (
            conn.relationshipChain?.map((rel: any) => ({
              type: rel.type,
              from: rel.start,
              to: rel.end,
            })) ?? []
          );
        });

        return {
          depth: parseInt(depth),
          count: depthConnections.length,
          chains,
          ...(depthConnections.length > connectionsToShow && {
            hasMore: depthConnections.length - connectionsToShow,
          }),
        };
      });
  }
}
