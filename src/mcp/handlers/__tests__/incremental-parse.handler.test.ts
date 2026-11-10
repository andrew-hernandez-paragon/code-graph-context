import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIND_BY_ID_QUERY } from '../../../core/projects/index.js';
import { QUERIES } from '../../../storage/neo4j/neo4j.service.js';
import { CANDIDATE_IMPORTS_QUERY, NODE_IDS_IN_FILES_QUERY } from '../dependent-files.js';
import { performIncrementalParse } from '../incremental-parse.handler.js';

type Row = Record<string, unknown>;
interface ImportedNode {
  id: string;
  properties: { name: string; filePath: string };
}
interface ImportedEdge {
  type: string;
  startNodeId: string;
  endNodeId: string;
}

const { graph } = vi.hoisted(() => ({
  graph: {
    run: undefined as unknown as (query: string, params: Row) => Promise<Row[]>,
    importedNodes: [] as ImportedNode[],
    importedEdges: [] as ImportedEdge[],
    imports: 0,
  },
}));

vi.mock('../../../storage/neo4j/neo4j.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../storage/neo4j/neo4j.service.js')>()),
  Neo4jService: class {
    run = (query: string, params: Row) => graph.run(query, params);
    close = vi.fn();
  },
}));
vi.mock('../../../core/utils/file-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/utils/file-utils.js')>()),
  debugLog: vi.fn(),
}));
vi.mock('../graph-generator.handler.js', () => ({
  GraphGeneratorHandler: class {
    setProjectId = vi.fn();
    generateGraph = async (graphJsonPath: string) => {
      const { nodes, edges } = JSON.parse(readFileSync(graphJsonPath, 'utf-8'));
      graph.importedNodes = nodes;
      graph.importedEdges = edges;
      graph.imports += 1;
      return { nodesImported: nodes.length, edgesImported: edges.length };
    };
  },
}));
vi.mock('../session-edge-recovery.helpers.js', () => ({ recoverSessionEdges: vi.fn() }));

const PROJECT_ID = 'proj_lab';
const SERVICE_RUN = 'proj_lab:MethodDeclaration:servicerun';
const DECOY_RUN = 'proj_lab:MethodDeclaration:decoyrun';
const SERVICE_FILE = 'proj_lab:SourceFile:service';

const SOURCES = {
  'service.ts': 'export class Service {\n  run(): number {\n    return 1;\n  }\n}\n',
  'decoy.ts': 'export class Decoy {\n  run(): number {\n    return 2;\n  }\n}\n',
  'caller.ts':
    "import { Service } from './service';\n\nexport function callService(service: Service): number {\n  return service.run();\n}\n",
};

const incomingEdgeFrom = (startFilePath: string) => ({
  startNodeId: `proj_lab:FunctionDeclaration:${startFilePath}`,
  startFilePath,
  endNodeId: 'proj_lab:FunctionDeclaration:target',
  edgeType: 'CALLS',
  edgeProperties: { lineNumber: 7 },
});
const INCOMING_EDGE = incomingEdgeFrom('/elsewhere/unchanged.ts');

describe('performIncrementalParse', () => {
  let root: string;
  let calls: Array<{ query: string; params: Row }>;
  const pathOf = (name: string) => join(root, 'src', name);
  const trackingRow = (name: string) => ({
    filePath: pathOf(name),
    mtime: statSync(pathOf(name)).mtimeMs,
    size: statSync(pathOf(name)).size,
    contentHash: createHash('sha256')
      .update(readFileSync(pathOf(name)))
      .digest('hex'),
  });
  const callsOf = (query: string) => calls.filter((call) => call.query === query);

  /** Answers the handler's queries from fixtures: `indexed` is what the graph holds before the parse. */
  const stubGraph = (
    indexed: Row[],
    stored: { registeredPath?: string; incomingEdges?: Row[]; nodeIds?: string[]; candidateImports?: Row[] } = {},
  ) => {
    calls = [];
    graph.importedNodes = [];
    graph.importedEdges = [];
    graph.imports = 0;
    graph.run = async (query, params) => {
      calls.push({ query, params });
      if (query === FIND_BY_ID_QUERY) {
        return [{ projectId: PROJECT_ID, name: 'lab', kind: 'codebase', path: stored.registeredPath ?? root }];
      }
      if (query === QUERIES.GET_SOURCE_FILE_TRACKING_INFO) return indexed;
      if (query === QUERIES.GET_INCOMING_EDGES) return stored.incomingEdges ?? [INCOMING_EDGE];
      if (query === QUERIES.RESTORE_INCOMING_EDGES) return [{ restoredCount: 1 }];
      if (query === NODE_IDS_IN_FILES_QUERY) return (stored.nodeIds ?? []).map((id) => ({ id }));
      if (query === CANDIDATE_IMPORTS_QUERY) return stored.candidateImports ?? [];
      if (query === QUERIES.GET_EXISTING_NODES_FOR_EDGE_DETECTION) {
        const node = (id: string, name: string, coreType: string, file: string, parentClassName: string | null) => ({
          id,
          name,
          coreType,
          semanticType: null,
          labels: ['TypeScript'],
          filePath: pathOf(file),
          parentClassName,
        });
        const excluded = params.excludeFilePaths as string[];
        return [
          node(DECOY_RUN, 'run', 'MethodDeclaration', 'decoy.ts', 'Decoy'),
          node(SERVICE_RUN, 'run', 'MethodDeclaration', 'service.ts', 'Service'),
          node(SERVICE_FILE, 'service.ts', 'SourceFile', 'service.ts', null),
        ].filter((existing) => !excluded.includes(existing.filePath));
      }
      return [];
    };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'incremental-parse-')));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"name": "lab"}');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions": {"module": "ESNext", "strict": true}}');
    for (const [name, source] of Object.entries(SOURCES)) writeFileSync(pathOf(name), source);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('imports the outgoing edges the parser resolved and restores only the saved incoming edges', async () => {
    stubGraph([
      trackingRow('service.ts'),
      trackingRow('decoy.ts'),
      { ...trackingRow('caller.ts'), contentHash: 'stale' },
    ]);

    const result = await performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'));

    expect(callsOf(QUERIES.GET_INCOMING_EDGES).map((call) => call.params)).toEqual([
      { filePaths: [pathOf('caller.ts')], projectId: PROJECT_ID },
    ]);
    const crossFileTargets = graph.importedEdges
      .filter((edge) => edge.type === 'CALLS' || edge.type === 'IMPORTS')
      .map((edge) => `${edge.type} ${edge.endNodeId}`);
    expect(crossFileTargets.sort()).toEqual([`CALLS ${SERVICE_RUN}`, `IMPORTS ${SERVICE_FILE}`]);
    expect(callsOf(QUERIES.RESTORE_INCOMING_EDGES).map((call) => call.params)).toEqual([
      { edges: [INCOMING_EDGE], projectId: PROJECT_ID },
    ]);
    expect(result.filesReparsed).toBe(1);
    expect(result.filesDeleted).toBe(0);
    expect(result.edgesUpdated).toBe(graph.importedEdges.length + 1);
  });

  it('parses an unchanged importer of a new declaration and imports its edges in place of the saved ones', async () => {
    writeFileSync(
      pathOf('service.ts'),
      `${SOURCES['service.ts']}\nexport function createService(): Service {\n  return new Service();\n}\n`,
    );
    const importOfNewFunction = "import { createService } from './service';";
    writeFileSync(
      pathOf('user.ts'),
      `${importOfNewFunction}\n\nexport function useService(): number {\n  return createService().run();\n}\n`,
    );
    stubGraph(
      [
        { ...trackingRow('service.ts'), contentHash: 'stale' },
        trackingRow('decoy.ts'),
        trackingRow('caller.ts'),
        trackingRow('user.ts'),
      ],
      {
        incomingEdges: [incomingEdgeFrom(pathOf('user.ts')), incomingEdgeFrom(pathOf('caller.ts'))],
        candidateImports: [
          { filePath: pathOf('user.ts'), moduleSpecifier: './service', sourceCode: importOfNewFunction },
        ],
      },
    );

    await performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'));

    expect([...new Set(graph.importedNodes.map((node) => node.properties.filePath))]).toEqual([pathOf('service.ts')]);
    const importedNames = new Map(graph.importedNodes.map((node) => [node.id, node.properties.name]));
    const edgesFromTheImporter = graph.importedEdges
      .filter((edge) => !importedNames.has(edge.startNodeId))
      .map((edge) => `${edge.type} ${importedNames.get(edge.endNodeId)}`);
    expect(edgesFromTheImporter.sort()).toEqual(['CALLS createService', 'IMPORTS service.ts']);
    expect(callsOf(QUERIES.RESTORE_INCOMING_EDGES).map((call) => call.params)).toEqual([
      { edges: [incomingEdgeFrom(pathOf('caller.ts'))], projectId: PROJECT_ID },
    ]);
  });

  it('looks for no importer when the reparse produced only nodes the graph already held', async () => {
    const changedCaller = [
      trackingRow('service.ts'),
      trackingRow('decoy.ts'),
      { ...trackingRow('caller.ts'), contentHash: 'stale' },
    ];
    stubGraph(changedCaller);
    await performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'));
    const nodeIds = graph.importedNodes.map((node) => node.id);

    stubGraph(changedCaller, { nodeIds });
    await performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'));

    expect(callsOf(NODE_IDS_IN_FILES_QUERY).map((call) => call.params)).toEqual([
      { filePaths: [pathOf('caller.ts')], projectId: PROJECT_ID },
    ]);
    expect(callsOf(CANDIDATE_IMPORTS_QUERY)).toEqual([]);
    expect(callsOf(QUERIES.RESTORE_INCOMING_EDGES).map((call) => call.params)).toEqual([
      { edges: [INCOMING_EDGE], projectId: PROJECT_ID },
    ]);
  });

  it('deletes the subgraph of a file that left the disk without importing or restoring anything', async () => {
    stubGraph([
      trackingRow('service.ts'),
      trackingRow('decoy.ts'),
      trackingRow('caller.ts'),
      { filePath: pathOf('gone.ts'), mtime: 1, size: 1, contentHash: 'gone' },
    ]);

    const result = await performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'));

    expect(callsOf(QUERIES.DELETE_SOURCE_FILE_SUBGRAPHS).map((call) => call.params)).toEqual([
      { filePaths: [pathOf('gone.ts')], projectId: PROJECT_ID },
    ]);
    expect(graph.imports).toBe(0);
    expect(callsOf(QUERIES.RESTORE_INCOMING_EDGES)).toEqual([]);
    expect(result).toEqual({ nodesUpdated: 0, edgesUpdated: 0, filesReparsed: 0, filesDeleted: 1 });
  });

  it('refuses a project registered at another directory before it reads or changes the graph', async () => {
    stubGraph([{ ...trackingRow('caller.ts'), contentHash: 'stale' }], { registeredPath: '/work/elsewhere' });

    await expect(performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'))).rejects.toThrow(
      `Codebase 'lab' (proj_lab) is registered at /work/elsewhere, not ${root}.`,
    );

    expect(calls.map((call) => call.query)).toEqual([FIND_BY_ID_QUERY]);
  });

  it('leaves the graph untouched when no file changed', async () => {
    stubGraph([trackingRow('service.ts'), trackingRow('decoy.ts'), trackingRow('caller.ts')]);

    const result = await performIncrementalParse(root, PROJECT_ID, join(root, 'tsconfig.json'));

    expect(callsOf(QUERIES.DELETE_SOURCE_FILE_SUBGRAPHS)).toEqual([]);
    expect(result).toEqual({ nodesUpdated: 0, edgesUpdated: 0, filesReparsed: 0, filesDeleted: 0 });
  });
});
