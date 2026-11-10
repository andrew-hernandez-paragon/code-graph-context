/**
 * Incremental Parse Handler
 * Handles incremental graph updates triggered by file watchers
 */

import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { CORE_TYPESCRIPT_SCHEMA, Neo4jEdge, Neo4jNode } from '../../core/config/schema.js';
import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { ParserFactory } from '../../core/parsers/parser-factory.js';
import type { TypeScriptParser } from '../../core/parsers/typescript-parser.js';
import { getProjectName, ProjectService } from '../../core/projects/index.js';
import { detectChangedFiles } from '../../core/utils/file-change-detection.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { FILE_PATHS, LOG_CONFIG } from '../constants.js';
import { debugLog } from '../utils.js';

import {
  IncomingEdge,
  deleteSourceFileSubgraphs,
  loadExistingNodesForEdgeDetection,
  restoreIncomingEdges,
  saveIncomingEdges,
} from './cross-file-edge.helpers.js';
import { GraphGeneratorHandler } from './graph-generator.handler.js';
import { recoverSessionEdges } from './session-edge-recovery.helpers.js';

interface IncrementalParseResult {
  nodesUpdated: number;
  edgesUpdated: number;
  filesReparsed: number;
  filesDeleted: number;
}

export interface ChangedFilesGraph {
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
  /** Edges from files that were not reparsed into the reparsed ones; restore them after importing `nodes`. */
  incomingEdges: IncomingEdge[];
  filesReparsed: number;
  filesDeleted: number;
}

/**
 * Deletes the subgraphs of the files that changed or disappeared since the last parse and parses the
 * changed ones. The caller imports `nodes` and `edges`, then restores `incomingEdges`.
 */
export const reparseChangedFiles = async (
  parser: TypeScriptParser,
  neo4jService: Neo4jService,
  projectPath: string,
  projectId: string,
): Promise<ChangedFilesGraph> => {
  const { filesToReparse, filesToDelete } = await detectChangedFiles(projectPath, neo4jService, projectId);
  await debugLog('Incremental change detection', {
    filesToReparse: filesToReparse.length,
    filesToDelete: filesToDelete.length,
  });

  const nothingToImport: ChangedFilesGraph = {
    nodes: [],
    edges: [],
    incomingEdges: [],
    filesReparsed: 0,
    filesDeleted: filesToDelete.length,
  };
  const removedFiles = [...filesToDelete, ...filesToReparse];
  if (removedFiles.length === 0) return nothingToImport;

  const incomingEdges = await saveIncomingEdges(neo4jService, removedFiles, projectId);
  await deleteSourceFileSubgraphs(neo4jService, removedFiles, projectId);
  if (filesToReparse.length === 0) return nothingToImport;

  parser.addExistingNodesFromChunk(await loadExistingNodesForEdgeDetection(neo4jService, removedFiles, projectId));
  await parser.parseWorkspace(filesToReparse);
  const { nodes, edges } = parser.exportToJson();
  await debugLog('Incremental parse: parsed changed files', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    incomingEdges: incomingEdges.length,
  });

  return { nodes, edges, incomingEdges, filesReparsed: filesToReparse.length, filesDeleted: filesToDelete.length };
};

/**
 * Performs incremental parsing for a project
 * This is used by the WatchManager when files change
 */
export const performIncrementalParse = async (
  projectPath: string,
  projectId: string,
  tsconfigPath: string,
): Promise<IncrementalParseResult> => {
  const neo4jService = new Neo4jService();
  const embeddingsService = new EmbeddingsService();
  const graphHandler = new GraphGeneratorHandler(neo4jService, embeddingsService);

  try {
    await debugLog('Incremental parse started', { projectPath, projectId });

    const projectName = await getProjectName(projectPath);

    // Create parser with auto-detection and lazy loading enabled for memory efficiency
    const parser = await ParserFactory.createParserWithAutoDetection(projectPath, tsconfigPath, projectId, true);

    const { nodes, edges, incomingEdges, filesReparsed, filesDeleted } = await reparseChangedFiles(
      parser,
      neo4jService,
      projectPath,
      projectId,
    );

    if (filesReparsed === 0 && filesDeleted === 0) {
      await debugLog('Incremental parse: no changes, returning early', {});
      return { nodesUpdated: 0, edgesUpdated: 0, filesReparsed, filesDeleted };
    }

    let nodesImported = 0;
    let edgesImported = 0;

    if (filesReparsed > 0) {
      // Get framework schemas if available (use unknown as intermediate to access private property)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parserAny = parser as any;
      const frameworkSchemas: string[] = Array.isArray(parserAny.frameworkSchemas)
        ? parserAny.frameworkSchemas.map((s: { name: string }) => s.name)
        : ['Auto-detected'];

      const graphData = {
        nodes,
        edges,
        metadata: {
          coreSchema: CORE_TYPESCRIPT_SCHEMA.name,
          frameworkSchemas,
          projectType: 'auto',
          projectId,
          generated: new Date().toISOString(),
        },
      };

      // Write to JSON file (required by GraphGeneratorHandler)
      const outputPath = join(projectPath, FILE_PATHS.graphOutput);
      writeFileSync(outputPath, JSON.stringify(graphData, null, LOG_CONFIG.jsonIndentation));

      await new ProjectService(neo4jService).upsertCodebase({
        projectId,
        path: projectPath,
        name: projectName,
        status: 'complete',
      });

      // Import nodes and edges (clearExisting = false for incremental)
      graphHandler.setProjectId(projectId);
      try {
        const result = await graphHandler.generateGraph(outputPath, false);
        nodesImported = result.nodesImported;
        edgesImported = result.edgesImported;
        await debugLog('Incremental parse: graph import completed', { nodesImported, edgesImported });
      } finally {
        // Clean up temporary graph.json file
        try {
          unlinkSync(outputPath);
        } catch {
          // Ignore cleanup errors - file may not exist or be inaccessible
        }
      }

      edgesImported += await restoreIncomingEdges(neo4jService, incomingEdges, projectId);
    }

    // Deleting a file's subgraph deleted the :ABOUT, :REFERENCES and :MARKS edges that pointed at it.
    await recoverSessionEdges(neo4jService, projectId);

    await debugLog('Incremental parse completed', { nodesImported, edgesImported, filesReparsed, filesDeleted });

    return { nodesUpdated: nodesImported, edgesUpdated: edgesImported, filesReparsed, filesDeleted };
  } finally {
    await neo4jService.close();
  }
};
