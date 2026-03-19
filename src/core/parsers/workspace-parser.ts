/**
 * Workspace Parser
 * Orchestrates parsing of multi-package monorepos
 */

import path from 'path';

import { glob } from 'glob';

import { EXCLUDE_PATTERNS_GLOB } from '../../constants.js';
import { FAIRSQUARE_FRAMEWORK_SCHEMA } from '../config/fairsquare-framework-schema.js';
import { NESTJS_FRAMEWORK_SCHEMA } from '../config/nestjs-framework-schema.js';
import { Neo4jNode, Neo4jEdge, ParsingContext, FrameworkSchema, EdgeEnhancement } from '../config/schema.js';
import { debugLog } from '../utils/file-utils.js';
import { createFrameworkEdgeData } from '../utils/graph-factory.js';
import { resolveProjectId } from '../utils/project-id.js';
import { WorkspaceConfig, WorkspacePackage } from '../workspace/index.js';

import { ParserFactory, ProjectType } from './parser-factory.js';
import { CallContext, TypeScriptParser } from './typescript-parser.js';

export interface WorkspaceParseResult {
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
  packageResults: Map<string, { nodes: number; edges: number }>;
}

interface DeferredEdge {
  edgeType: string;
  sourceNodeId: string;
  targetName: string;
  targetType: string;
  targetFilePath?: string; // File path of target for precise matching (used for EXTENDS/IMPLEMENTS)
  callContext?: CallContext;
}

/**
 * Lightweight node for cross-package edge detection.
 * Only stores what's needed for edge enhancement detection patterns.
 * Does NOT store AST references (sourceNode) to prevent memory bloat.
 */
interface LightweightParsedNode {
  id: string;
  coreType?: string; // Needed for detection patterns that check node type
  semanticType?: string;
  properties: {
    name?: string;
    coreType?: string; // Duplicated from top-level for detection patterns that read properties.coreType
    semanticType?: string; // Duplicated for detection patterns that read properties.semanticType
    filePath?: string; // Needed for EXPOSES detection (same-file check)
    parentClassName?: string; // Needed for EXPOSES detection (method→controller matching)
    context?: Record<string, any>; // Contains constructorParamTypes, routes, etc.
  };
}

export class WorkspaceParser {
  private config: WorkspaceConfig;
  private projectId: string;
  private projectType: ProjectType | 'auto';
  private lazyLoad: boolean;
  private discoveredFiles: Map<string, string[]> | null = null;
  private parsedNodes: Map<string, Neo4jNode> = new Map();
  private parsedEdges: Map<string, Neo4jEdge> = new Map();
  private accumulatedDeferredEdges: DeferredEdge[] = [];
  // Shared context across all packages for cross-package edge detection
  private sharedContext: ParsingContext = new Map();
  // Lightweight node copies for cross-package edge detection (no AST references)
  private accumulatedParsedNodes: Map<string, LightweightParsedNode> = new Map();
  // Framework schemas detected from packages (for edge enhancements)
  private frameworkSchemas: FrameworkSchema[] = [];
  // Track already exported items to avoid returning duplicates in streaming mode
  private exportedNodeIds: Set<string> = new Set();
  private exportedEdgeIds: Set<string> = new Set();
  // Resolver parser for delegating edge resolution to TypeScriptParser
  private resolverParser: TypeScriptParser | null = null;

  constructor(
    config: WorkspaceConfig,
    projectId?: string,
    lazyLoad: boolean = true,
    projectType: ProjectType | 'auto' = 'auto',
  ) {
    this.config = config;
    this.projectId = resolveProjectId(config.rootPath, projectId);
    this.lazyLoad = lazyLoad;
    this.projectType = projectType;
  }

  /**
   * Get the project ID for this workspace
   */
  getProjectId(): string {
    return this.projectId;
  }

  /**
   * Get workspace configuration
   */
  getConfig(): WorkspaceConfig {
    return this.config;
  }

  /**
   * Discover all source files across all packages
   */
  async discoverSourceFiles(): Promise<string[]> {
    if (this.discoveredFiles !== null) {
      // Return flattened list
      return Array.from(this.discoveredFiles.values()).flat();
    }

    this.discoveredFiles = new Map();
    let totalFiles = 0;
    const packageCounts: Record<string, number> = {};

    for (const pkg of this.config.packages) {
      const files = await this.discoverPackageFiles(pkg);
      this.discoveredFiles.set(pkg.name, files);
      totalFiles += files.length;
      packageCounts[pkg.name] = files.length;
    }

    await debugLog('WorkspaceParser discovered files', {
      totalFiles,
      packageCount: this.config.packages.length,
      packageCounts,
    });

    return Array.from(this.discoveredFiles.values()).flat();
  }

  /**
   * Discover files in a single package
   */
  private async discoverPackageFiles(pkg: WorkspacePackage): Promise<string[]> {
    // Include both .ts and .tsx files
    // Use EXCLUDE_PATTERNS_GLOB for consistency with detectChangedFiles and TypeScriptParser
    const pattern = path.join(pkg.path, '**/*.{ts,tsx}');
    const files = await glob(pattern, {
      ignore: EXCLUDE_PATTERNS_GLOB,
      absolute: true,
    });
    return files;
  }

  /**
   * Get files grouped by package
   */
  async getFilesByPackage(): Promise<Map<string, string[]>> {
    if (this.discoveredFiles === null) {
      await this.discoverSourceFiles();
    }
    return this.discoveredFiles!;
  }

  /**
   * Create a parser for a package using ParserFactory (supports auto-detection)
   * Injects the shared context so context is shared across all packages.
   */
  private async createParserForPackage(pkg: WorkspacePackage): Promise<TypeScriptParser> {
    const tsConfigPath = pkg.tsConfigPath ?? path.join(pkg.path, 'tsconfig.json');

    let parser: TypeScriptParser;
    if (this.projectType === 'auto') {
      // Auto-detect framework for this specific package
      parser = await ParserFactory.createParserWithAutoDetection(pkg.path, tsConfigPath, this.projectId, this.lazyLoad);
    } else {
      // Use the specified project type for all packages
      parser = ParserFactory.createParser({
        workspacePath: pkg.path,
        tsConfigPath,
        projectType: this.projectType,
        projectId: this.projectId,
        lazyLoad: this.lazyLoad,
      });
    }

    // Inject shared context so all packages share the same context
    // This enables cross-package edge detection (e.g., INTERNAL_API_CALL)
    parser.setSharedContext(this.sharedContext);

    // Defer edge enhancements to WorkspaceParser's final pass
    // This avoids duplicate work and enables cross-package edge detection
    parser.setDeferEdgeEnhancements(true);

    return parser;
  }

  /**
   * Parse a single package and return its results
   */
  async parsePackage(pkg: WorkspacePackage): Promise<{ nodes: Neo4jNode[]; edges: Neo4jEdge[] }> {
    await debugLog(`Parsing package: ${pkg.name}`);

    const parser = await this.createParserForPackage(pkg);

    // Discover files for this package
    const files = await this.discoverPackageFiles(pkg);
    if (files.length === 0) {
      await debugLog(`No TypeScript files found in ${pkg.name}`);
      return { nodes: [], edges: [] };
    }

    await debugLog(`${pkg.name}: ${files.length} files to parse`);

    // Parse all files in this package
    const result = await parser.parseChunk(files, true); // Skip edge resolution for now

    // Add package name to all nodes
    for (const node of result.nodes) {
      node.properties.packageName = pkg.name;
    }

    await debugLog(`${pkg.name}: ${result.nodes.length} nodes, ${result.edges.length} edges`);

    return result;
  }

  /**
   * Parse a chunk of files (for streaming compatibility)
   * Files are grouped by package and parsed together
   */
  async parseChunk(
    filePaths: string[],
    skipEdgeResolution: boolean = false,
  ): Promise<{ nodes: Neo4jNode[]; edges: Neo4jEdge[] }> {
    // Group files by package
    const filesByPackage = new Map<WorkspacePackage, string[]>();

    for (const filePath of filePaths) {
      const pkg = this.findPackageForFile(filePath);
      if (pkg) {
        const files = filesByPackage.get(pkg) ?? [];
        files.push(filePath);
        filesByPackage.set(pkg, files);
      }
    }

    const allNodes: Neo4jNode[] = [];
    const allEdges: Neo4jEdge[] = [];

    // Parse each package's files
    for (const [pkg, files] of filesByPackage) {
      try {
        const parser = await this.createParserForPackage(pkg);

        const result = await parser.parseChunk(files, skipEdgeResolution);

        // Add package name to nodes
        for (const node of result.nodes) {
          node.properties.packageName = pkg.name;
        }

        // Export and accumulate deferred edges for cross-package resolution
        const chunkData = parser.exportChunkResults();
        this.accumulatedDeferredEdges.push(...chunkData.deferredEdges);

        // Accumulate LIGHTWEIGHT copies of ParsedNodes for cross-package edge detection
        // Only stores what's needed for detection patterns - NO AST references
        const innerParsedNodes = parser.getParsedNodes();
        for (const [nodeId, parsedNode] of innerParsedNodes) {
          this.accumulatedParsedNodes.set(nodeId, {
            id: parsedNode.id,
            coreType: parsedNode.coreType, // Needed for detection patterns
            semanticType: parsedNode.semanticType,
            properties: {
              name: parsedNode.properties.name,
              coreType: parsedNode.properties.coreType,
              semanticType: parsedNode.properties.semanticType,
              filePath: parsedNode.properties.filePath,
              parentClassName: parsedNode.properties.parentClassName,
              context: parsedNode.properties.context, // Contains constructorParamTypes, dependencies
            },
          });
        }

        // Accumulate framework schemas (deduplicated by name)
        for (const schema of parser.getFrameworkSchemas()) {
          if (!this.frameworkSchemas.some((s) => s.name === schema.name)) {
            this.frameworkSchemas.push(schema);
          }
        }

        allNodes.push(...result.nodes);
        allEdges.push(...result.edges);
      } catch (error) {
        console.warn(`⚠️ Failed to parse package ${pkg.name}:`, error);
        // Continue with other packages
      }
    }

    // Only return nodes/edges that haven't been exported yet (prevents duplicate imports in streaming mode)
    const newNodes = allNodes.filter((node) => {
      if (!this.exportedNodeIds.has(node.id)) {
        this.exportedNodeIds.add(node.id);
        return true;
      }
      return false;
    });

    const newEdges = allEdges.filter((edge) => {
      if (!this.exportedEdgeIds.has(edge.id)) {
        this.exportedEdgeIds.add(edge.id);
        return true;
      }
      return false;
    });

    return { nodes: newNodes, edges: newEdges };
  }

  /**
   * Find which package a file belongs to
   */
  private findPackageForFile(filePath: string): WorkspacePackage | null {
    for (const pkg of this.config.packages) {
      if (filePath.startsWith(pkg.path)) {
        return pkg;
      }
    }
    return null;
  }

  /**
   * Parse all packages in the workspace
   */
  async parseAll(): Promise<WorkspaceParseResult> {
    const packageResults = new Map<string, { nodes: number; edges: number }>();
    const allNodes: Neo4jNode[] = [];
    const allEdges: Neo4jEdge[] = [];

    for (const pkg of this.config.packages) {
      const result = await this.parsePackage(pkg);

      allNodes.push(...result.nodes);
      allEdges.push(...result.edges);

      packageResults.set(pkg.name, {
        nodes: result.nodes.length,
        edges: result.edges.length,
      });
    }

    await debugLog(`Workspace parsing complete! Total: ${allNodes.length} nodes, ${allEdges.length} edges`);

    return {
      nodes: allNodes,
      edges: allEdges,
      packageResults,
    };
  }

  /**
   * Clear parsed data (for memory management)
   * Note: Does NOT clear accumulated deferred edges - those need to be resolved at the end
   */
  clearParsedData(): void {
    this.parsedNodes.clear();
    this.parsedEdges.clear();
    this.exportedNodeIds.clear();
    this.exportedEdgeIds.clear();
  }

  /**
   * Add existing nodes for cross-package edge resolution
   */
  addExistingNodesFromChunk(nodes: Neo4jNode[]): void {
    for (const node of nodes) {
      this.parsedNodes.set(node.id, node);
    }
  }

  /**
   * Add nodes to accumulatedParsedNodes for edge enhancement.
   * Converts Neo4jNode to LightweightParsedNode format.
   */
  addParsedNodesFromChunk(nodes: Neo4jNode[]): void {
    for (const node of nodes) {
      this.parsedNodes.set(node.id, node);
      // Also add to accumulatedParsedNodes for edge enhancement detection
      this.accumulatedParsedNodes.set(node.id, {
        id: node.id,
        coreType: node.properties.coreType as string,
        semanticType: node.properties.semanticType as string | undefined,
        properties: {
          name: node.properties.name as string | undefined,
          coreType: node.properties.coreType as string | undefined,
          semanticType: node.properties.semanticType as string | undefined,
          filePath: node.properties.filePath as string | undefined,
          parentClassName: node.properties.parentClassName as string | undefined,
          context: node.properties.context as Record<string, any> | undefined,
        },
      });
    }
  }

  /**
   * Get current counts for progress reporting
   */
  getCurrentCounts(): { nodes: number; edges: number; deferredEdges: number } {
    return {
      nodes: this.parsedNodes.size,
      edges: this.parsedEdges.size,
      deferredEdges: this.accumulatedDeferredEdges.length,
    };
  }

  /**
   * Set whether to defer edge enhancements.
   * WorkspaceParser always defers edge enhancements to applyEdgeEnhancementsManually(),
   * so this is a no-op for interface compliance.
   */
  setDeferEdgeEnhancements(_defer: boolean): void {
    // No-op: WorkspaceParser always handles edge enhancements at the end
  }

  /**
   * Load framework schemas for a specific project type.
   * Used by parallel parsing coordinator to load schemas before edge enhancement.
   * In sequential parsing, schemas are accumulated from inner parsers instead.
   */
  loadFrameworkSchemasForType(projectType: string): void {
    // Load schemas based on project type (same logic as ParserFactory.selectFrameworkSchemas)
    switch (projectType) {
      case 'nestjs':
        if (!this.frameworkSchemas.some((s) => s.name === NESTJS_FRAMEWORK_SCHEMA.name)) {
          this.frameworkSchemas.push(NESTJS_FRAMEWORK_SCHEMA);
        }
        break;
      case 'fairsquare':
        if (!this.frameworkSchemas.some((s) => s.name === FAIRSQUARE_FRAMEWORK_SCHEMA.name)) {
          this.frameworkSchemas.push(FAIRSQUARE_FRAMEWORK_SCHEMA);
        }
        break;
      case 'both':
        if (!this.frameworkSchemas.some((s) => s.name === FAIRSQUARE_FRAMEWORK_SCHEMA.name)) {
          this.frameworkSchemas.push(FAIRSQUARE_FRAMEWORK_SCHEMA);
        }
        if (!this.frameworkSchemas.some((s) => s.name === NESTJS_FRAMEWORK_SCHEMA.name)) {
          this.frameworkSchemas.push(NESTJS_FRAMEWORK_SCHEMA);
        }
        break;
      // 'vanilla' and 'auto' - no framework schemas
    }
    debugLog('WorkspaceParser loaded framework schemas', { count: this.frameworkSchemas.length, projectType });
  }

  /**
   * Get serialized shared context for parallel parsing.
   * Converts Maps to arrays for structured clone compatibility.
   */
  getSerializedSharedContext(): Array<[string, unknown]> {
    const serialized: Array<[string, unknown]> = [];
    for (const [key, value] of this.sharedContext) {
      if (value instanceof Map) {
        serialized.push([key, Array.from((value as Map<string, unknown>).entries())]);
      } else {
        serialized.push([key, value]);
      }
    }
    return serialized;
  }

  /**
   * Merge serialized shared context from workers.
   * Handles Map merging by combining entries.
   */
  mergeSerializedSharedContext(serialized: Array<[string, unknown]>): void {
    for (const [key, value] of serialized) {
      if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
        // It's a serialized Map - merge with existing
        const existingMap = this.sharedContext.get(key) as Map<string, unknown> | undefined;
        const newMap = existingMap ?? new Map<string, unknown>();
        for (const [k, v] of value as Array<[string, unknown]>) {
          newMap.set(k, v);
        }
        this.sharedContext.set(key, newMap as any);
      } else {
        // Simple value - just set it
        this.sharedContext.set(key, value as any);
      }
    }
  }

  /**
   * Get deferred edges for cross-chunk resolution.
   * Returns serializable format for worker thread transfer.
   */
  getDeferredEdges(): Array<{
    edgeType: string;
    sourceNodeId: string;
    targetName: string;
    targetType: string;
    targetFilePath?: string;
  }> {
    return this.accumulatedDeferredEdges.map((e) => ({
      edgeType: e.edgeType,
      sourceNodeId: e.sourceNodeId,
      targetName: e.targetName,
      targetType: e.targetType,
      targetFilePath: e.targetFilePath,
    }));
  }

  /**
   * Merge deferred edges from workers for resolution.
   */
  mergeDeferredEdges(
    edges: Array<{
      edgeType: string;
      sourceNodeId: string;
      targetName: string;
      targetType: string;
      targetFilePath?: string;
    }>,
  ): void {
    for (const e of edges) {
      this.accumulatedDeferredEdges.push({
        edgeType: e.edgeType,
        sourceNodeId: e.sourceNodeId,
        targetName: e.targetName,
        targetType: e.targetType,
        targetFilePath: e.targetFilePath,
      });
    }
  }

  /**
   * Resolve accumulated deferred edges against all parsed nodes
   * Call this after all chunks have been parsed
   */
  async resolveDeferredEdges(): Promise<Neo4jEdge[]> {
    if (this.accumulatedDeferredEdges.length === 0) {
      return [];
    }

    // Create or reuse resolver parser - delegates all resolution logic to TypeScriptParser
    // Uses createResolver() which doesn't require ts-morph initialization
    if (!this.resolverParser) {
      this.resolverParser = TypeScriptParser.createResolver(this.projectId);
    }

    // Populate resolver with accumulated nodes (builds CALLS indexes automatically)
    this.resolverParser.addParsedNodesFromChunk(Array.from(this.parsedNodes.values()));

    // Transfer deferred edges to resolver
    this.resolverParser.mergeDeferredEdges(this.accumulatedDeferredEdges);

    // Delegate resolution to TypeScriptParser
    const resolvedEdges = await this.resolverParser.resolveDeferredEdges();

    // Clear accumulated deferred edges after resolution
    this.accumulatedDeferredEdges = [];

    return resolvedEdges;
  }

  /**
   * Apply edge enhancements on all accumulated nodes across all packages.
   * This enables cross-package edge detection (e.g., INTERNAL_API_CALL between services and
   * vendor controllers in different packages).
   *
   * Uses shared context and accumulated ParsedNodes from all packages.
   * @returns New edges created by edge enhancements
   */
  async applyEdgeEnhancementsManually(): Promise<Neo4jEdge[]> {
    if (this.accumulatedParsedNodes.size === 0) {
      await debugLog('WorkspaceParser: No accumulated nodes for edge enhancements');
      return [];
    }

    if (this.frameworkSchemas.length === 0) {
      await debugLog('WorkspaceParser: No framework schemas for edge enhancements');
      return [];
    }

    await debugLog(
      `WorkspaceParser: Applying edge enhancements on ${this.accumulatedParsedNodes.size} accumulated nodes across all packages...`,
    );

    // Pre-index nodes by semantic type for O(1) lookups
    const nodesBySemanticType = new Map<string, Map<string, LightweightParsedNode>>();
    for (const [nodeId, node] of this.accumulatedParsedNodes) {
      const semanticType = node.semanticType ?? 'unknown';
      if (!nodesBySemanticType.has(semanticType)) {
        nodesBySemanticType.set(semanticType, new Map());
      }
      nodesBySemanticType.get(semanticType)!.set(nodeId, node);
    }

    const typeCounts: Record<string, number> = {};
    for (const [type, nodes] of nodesBySemanticType) {
      typeCounts[type] = nodes.size;
    }
    await debugLog(`Node distribution by semantic type: ${JSON.stringify(typeCounts)}`);

    const newEdges: Neo4jEdge[] = [];
    const edgeCountBefore = this.parsedEdges.size;

    // Apply edge enhancements from all framework schemas
    for (const frameworkSchema of this.frameworkSchemas) {
      for (const edgeEnhancement of Object.values(frameworkSchema.edgeEnhancements)) {
        const enhancementEdges = await this.applyEdgeEnhancement(edgeEnhancement, nodesBySemanticType);
        newEdges.push(...enhancementEdges);
      }
    }

    const newEdgeCount = this.parsedEdges.size - edgeCountBefore;
    await debugLog(`Created ${newEdgeCount} cross-package edges from edge enhancements`);

    return newEdges;
  }

  /**
   * Apply a single edge enhancement across all accumulated parsed nodes.
   * Uses LightweightParsedNode which contains only fields needed for detection:
   * - id, semanticType, properties.context (with propertyTypes)
   * Detection patterns must NOT access sourceNode (AST) - use properties instead.
   */
  private async applyEdgeEnhancement(
    edgeEnhancement: EdgeEnhancement,
    _nodesBySemanticType: Map<string, Map<string, LightweightParsedNode>>,
  ): Promise<Neo4jEdge[]> {
    const newEdges: Neo4jEdge[] = [];
    // Track created edges with simple key to avoid duplicate hash computations
    const createdEdgeKeys = new Set<string>();

    try {
      // For now, iterate all nodes. Detection pattern short-circuits on semantic type.
      // Future optimization: use _nodesBySemanticType to only iterate relevant pairs.
      const allTargetNodes = new Map([...this.accumulatedParsedNodes]);

      for (const [sourceId, sourceNode] of this.accumulatedParsedNodes) {
        for (const [targetId, targetNode] of allTargetNodes) {
          if (sourceId === targetId) continue;

          // Run detection pattern FIRST (cheap semantic type checks)
          if (
            edgeEnhancement.detectionPattern(
              sourceNode as any,
              targetNode as any,
              this.accumulatedParsedNodes as any,
              this.sharedContext,
            )
          ) {
            const simpleKey = `${sourceId}:${targetId}`;
            if (createdEdgeKeys.has(simpleKey)) continue;
            createdEdgeKeys.add(simpleKey);

            // Extract context for this edge
            let context = {};
            if (edgeEnhancement.contextExtractor) {
              context = edgeEnhancement.contextExtractor(
                sourceNode as any,
                targetNode as any,
                this.accumulatedParsedNodes as any,
                this.sharedContext,
              );
            }

            const edge = this.createFrameworkEdge(
              edgeEnhancement.semanticType,
              edgeEnhancement.neo4j.relationshipType,
              sourceId,
              targetId,
              context,
              edgeEnhancement.relationshipWeight,
            );
            this.parsedEdges.set(edge.id, edge);
            newEdges.push(edge);
          }
        }
      }
    } catch (error) {
      console.error(`Error applying edge enhancement ${edgeEnhancement.name}:`, error);
    }

    return newEdges;
  }

  /**
   * Create a framework edge with semantic type and properties.
   */
  private createFrameworkEdge(
    semanticType: string,
    relationshipType: string,
    sourceId: string,
    targetId: string,
    context: Record<string, any>,
    relationshipWeight: number,
  ): Neo4jEdge {
    const { id, properties } = createFrameworkEdgeData({
      semanticType,
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      projectId: this.projectId,
      context,
      relationshipWeight,
    });

    return {
      id,
      type: relationshipType,
      startNodeId: sourceId,
      endNodeId: targetId,
      properties,
    };
  }
}
