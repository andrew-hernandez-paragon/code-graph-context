/**
 * Incremental Parse Handler
 * Handles incremental graph updates triggered by file watchers
 */

import { writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';

import { CORE_TYPESCRIPT_SCHEMA, CoreEdgeType, Neo4jEdge, Neo4jNode } from '../../core/config/schema.js';
import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { ParserFactory } from '../../core/parsers/parser-factory.js';
import type { TypeScriptParser } from '../../core/parsers/typescript-parser.js';
import { getProjectName, ProjectService, type Project } from '../../core/projects/index.js';
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
import {
  SubtypeEdge,
  deleteOutgoingEdges,
  describeSubtypeChanges,
  findDependentFiles,
  findImportersThroughReExports,
  findReExportingFiles,
  reExportingFilesOf,
  loadNodeIds,
  loadSubtypeEdges,
} from './dependent-files.js';
import { GraphGeneratorHandler } from './graph-generator.handler.js';
import { recoverSessionEdges } from './session-edge-recovery.helpers.js';

interface IncrementalParseResult {
  nodesUpdated: number;
  edgesUpdated: number;
  filesReparsed: number;
  filesDeleted: number;
}

/**
 * Node ids hash each file's absolute path, so parsing a codebase from a directory other than its
 * registered root would delete every node and re-create it under a new id.
 */
export const registeredPathMismatch = (project: Project, projectPath: string): string | null => {
  const requestedPath = resolve(projectPath);
  if (project.path !== null && resolve(project.path) === requestedPath) return null;
  return (
    `Codebase '${project.name}' (${project.projectId}) is registered at ${project.path}, not ${requestedPath}. ` +
    `Parsing another directory under its id would replace every node id in its graph. ` +
    `Pass ${project.path} as projectPath, or parse ${requestedPath} as its own codebase.`
  );
};

export interface ChangedFilesGraph {
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
  /** Edges from files that were not reparsed into the reparsed ones; restore them after importing `nodes`. */
  incomingEdges: IncomingEdge[];
  filesReparsed: number;
  filesDeleted: number;
}

/** The EXTENDS and IMPLEMENTS edges a parse produced for the reparsed nodes, in the shape of the stored ones. */
const subtypeEdgesOf = (edges: Neo4jEdge[], reparsedNodes: Neo4jNode[], existingNodes: Neo4jNode[]): SubtypeEdge[] => {
  const reparsedById = new Map(reparsedNodes.map((node) => [node.id, node.properties]));
  const existingById = new Map(existingNodes.map((node) => [node.id, node.properties]));
  return edges.flatMap((edge) => {
    const subtype = reparsedById.get(edge.startNodeId);
    const supertype = reparsedById.get(edge.endNodeId) ?? existingById.get(edge.endNodeId);
    const isSubtypeEdge = edge.type === CoreEdgeType.EXTENDS || edge.type === CoreEdgeType.IMPLEMENTS;
    if (!subtype || !supertype || !isSubtypeEdge) return [];
    return [
      {
        subtypeId: edge.startNodeId,
        subtypeName: subtype.name,
        subtypeFilePath: subtype.filePath,
        edgeType: edge.type,
        supertypeId: edge.endNodeId,
        supertypeName: supertype.name,
        supertypeType: supertype.coreType,
        supertypeFilePath: supertype.filePath,
      },
    ];
  });
};

/**
 * Parses the files that changed since the last parse, along with the unchanged files that import a
 * declaration the graph has not held before, then deletes the subgraphs of the files that changed or
 * disappeared. The caller imports `nodes` and `edges`, then restores `incomingEdges`.
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
  if (filesToReparse.length === 0) {
    if (filesToDelete.length > 0) {
      await deleteSourceFileSubgraphs(neo4jService, filesToDelete, projectId);
    }
    return nothingToImport;
  }
  const removedFiles = [...filesToDelete, ...filesToReparse];

  const savedIncomingEdges = await saveIncomingEdges(neo4jService, removedFiles, projectId);
  const previousNodeIds = await loadNodeIds(neo4jService, filesToReparse, projectId);
  const storedSubtypeEdges = await loadSubtypeEdges(neo4jService, projectId);
  const storedBarrels = await findReExportingFiles(neo4jService, removedFiles, projectId);

  const existingNodes = await loadExistingNodesForEdgeDetection(neo4jService, removedFiles, projectId);
  parser.addExistingNodesFromChunk(existingNodes);
  // A call through an interface links to its implementers, which the parser finds only among the edges it holds.
  parser.mergeDeferredEdges(
    storedSubtypeEdges
      .filter((edge) => !removedFiles.includes(edge.subtypeFilePath))
      .map((edge) => ({
        edgeType: edge.edgeType,
        sourceNodeId: edge.subtypeId,
        targetName: edge.supertypeName,
        targetType: edge.supertypeType,
        targetFilePath: edge.supertypeFilePath,
      })),
  );
  await parser.parseWorkspace(filesToReparse);
  const reparsed = parser.exportToJson();
  const nodes = reparsed.nodes;
  const reparsedNodeIds = new Set(nodes.map((node) => node.id));

  const newNodes = nodes.filter((node) => !previousNodeIds.has(node.id));
  const subtypeChanges = describeSubtypeChanges(
    storedSubtypeEdges.filter((edge) => filesToReparse.includes(edge.subtypeFilePath)),
    subtypeEdgesOf(reparsed.edges, nodes, existingNodes),
  );
  const referencingFiles = await findDependentFiles(neo4jService, newNodes, subtypeChanges, removedFiles, projectId);
  const barrels = new Set([...storedBarrels, ...reExportingFilesOf(nodes)]);
  const barrelImporters = await findImportersThroughReExports(neo4jService, [...barrels], projectId);
  const dependentFiles = new Set(
    [...referencingFiles, ...barrelImporters].filter((filePath) => !removedFiles.includes(filePath)),
  );
  if (dependentFiles.size > 0) {
    await parser.parseWorkspace([...dependentFiles]);
  }
  const parsed = parser.exportToJson();
  const dependentNodeIds = new Set(
    parsed.nodes.filter((node) => dependentFiles.has(node.properties.filePath)).map((node) => node.id),
  );

  // Nothing is deleted until the parse has succeeded, so a parse that throws leaves the old subgraphs in place.
  await deleteSourceFileSubgraphs(neo4jService, removedFiles, projectId);
  if (dependentFiles.size > 0) {
    // A dependent file keeps its nodes and gets the outgoing edges this parse produced in place of its stored ones.
    await deleteOutgoingEdges(neo4jService, [...dependentFiles], projectId);
  }

  const edges = parsed.edges.filter(
    (edge) => reparsedNodeIds.has(edge.startNodeId) || dependentNodeIds.has(edge.startNodeId),
  );
  const incomingEdges = savedIncomingEdges.filter((edge) => !dependentFiles.has(edge.startFilePath));
  await debugLog('Incremental parse: parsed changed files', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    dependentFiles: dependentFiles.size,
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

    const projectService = new ProjectService(neo4jService);
    const project = await projectService.findById(projectId);
    const mismatch = project && registeredPathMismatch(project, projectPath);
    if (mismatch) throw new Error(mismatch);

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

      await projectService.upsertCodebase({
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
