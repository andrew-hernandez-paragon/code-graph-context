/**
 * Cross-File Edge Helpers
 * Shared utilities for managing cross-file edges during incremental parsing
 */

import type { Neo4jNode, Neo4jNodeProperties } from '../../core/config/schema.js';
import { toNumber } from '../../core/utils/shared-utils.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';

/** An edge from a node in a file that stays in the graph to a node in a file being reparsed or deleted. */
export interface IncomingEdge {
  startNodeId: string;
  startFilePath: string;
  endNodeId: string;
  edgeType: string;
  edgeProperties: Record<string, unknown>;
}

export const deleteSourceFileSubgraphs = async (
  neo4jService: Neo4jService,
  filePaths: string[],
  projectId: string,
): Promise<void> => {
  await neo4jService.run(QUERIES.DELETE_SOURCE_FILE_SUBGRAPHS, { filePaths, projectId });
};

export const loadExistingNodesForEdgeDetection = async (
  neo4jService: Neo4jService,
  excludeFilePaths: string[],
  projectId: string,
): Promise<Neo4jNode[]> => {
  const rows = await neo4jService.run(QUERIES.GET_EXISTING_NODES_FOR_EDGE_DETECTION, { excludeFilePaths, projectId });
  return rows.map((row) => ({
    id: row.id,
    labels: row.labels,
    // The parser resolves edge targets from these fields alone, so source text and line numbers stay in Neo4j.
    properties: {
      id: row.id,
      projectId,
      name: row.name,
      coreType: row.coreType,
      semanticType: row.semanticType ?? undefined,
      filePath: row.filePath,
      parentClassName: row.parentClassName ?? undefined,
    } as Neo4jNodeProperties,
  }));
};

export const saveIncomingEdges = async (
  neo4jService: Neo4jService,
  filePaths: string[],
  projectId: string,
): Promise<IncomingEdge[]> => {
  const rows = await neo4jService.run(QUERIES.GET_INCOMING_EDGES, { filePaths, projectId });
  return rows.map((row) => ({
    startNodeId: row.startNodeId,
    startFilePath: row.startFilePath,
    endNodeId: row.endNodeId,
    edgeType: row.edgeType,
    edgeProperties: row.edgeProperties,
  }));
};

export const restoreIncomingEdges = async (
  neo4jService: Neo4jService,
  edges: IncomingEdge[],
  projectId: string,
): Promise<number> => {
  if (edges.length === 0) return 0;
  const rows = await neo4jService.run(QUERIES.RESTORE_INCOMING_EDGES, { edges, projectId });
  return toNumber(rows[0]?.restoredCount);
};
