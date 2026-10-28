import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QUERIES } from '../../../storage/neo4j/neo4j.service.js';
import { createImpactAnalysisTool } from '../impact-analysis.tool.js';

const { run, close } = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../../../storage/neo4j/neo4j.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../storage/neo4j/neo4j.service.js')>()),
  Neo4jService: vi.fn(function () {
    return { run, close };
  }),
}));
vi.mock('../../utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils.js')>()),
  findCodebaseOrError: vi.fn(async (projectId: string) => ({ success: true, project: { projectId } })),
  debugLog: vi.fn(),
}));

const sourceFile = { id: 'file', name: 'feature.ts', filePath: '/repo/feature.ts', coreType: 'SourceFile' };
const dependent = (nodeId: string, overrides: Record<string, unknown> = {}) => ({
  nodeId,
  name: nodeId,
  coreType: 'FunctionDeclaration',
  filePath: `/repo/${nodeId}.ts`,
  relationshipType: 'CALLS',
  weight: 0.75,
  targetNodeId: 'arrow',
  targetNodeName: 'runFeature',
  targetNodeType: 'VariableDeclaration',
  ...overrides,
});
const invoke = async (args: Record<string, unknown>) => {
  const registerTool = vi.fn();
  createImpactAnalysisTool({ registerTool } as unknown as McpServer);
  return registerTool.mock.calls[0][2]({ projectId: 'proj_test', maxDepth: 4, ...args });
};
const resultJson = (response: any) => JSON.parse(response.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  run.mockImplementation(async (query: string) => {
    if (query.includes('RETURN sf.id AS nodeId LIMIT 1')) return [{ nodeId: 'file' }];
    if (query === QUERIES.GET_NODE_BY_ID) return [sourceFile];
    if (query === QUERIES.GET_FILE_NODE_IDS)
      return [{ nodeId: 'interface' }, { nodeId: 'arrow' }, { nodeId: 'method' }];
    return [];
  });
});

describe('file impact', () => {
  it('uses all indexed symbols for direct and transitive impact and names the actual called symbol', async () => {
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      if (query === QUERIES.GET_NODES_IMPACT) return [dependent('caller'), dependent('caller', { weight: 0.5 })];
      if (query === QUERIES.GET_NODES_TRANSITIVE_DEPENDENTS(4))
        return [
          dependent('caller', { depth: 2 }),
          dependent('downstream', { depth: 3 }),
          dependent('downstream', { depth: 2 }),
        ];
      return original(query, params);
    });
    const result = resultJson(await invoke({ filePath: '/repo/feature.ts' }));
    expect(result.target).toEqual({ ...sourceFile, coreType: undefined, type: 'SourceFile' });
    expect(result.analysis).toMatchObject({ scope: 'file', analyzedNodeCount: 4, freshness: 'not_verified' });
    expect(result.directDependents.count).toBe(1);
    expect(result.transitiveDependents).toMatchObject({ count: 1, maxDepth: 2 });
    expect(result.affectedFiles).toEqual(['/repo/caller.ts', '/repo/downstream.ts']);
    expect(result.criticalPaths).toEqual(['caller (FunctionDeclaration) -[CALLS]-> runFeature (VariableDeclaration)']);
    for (const query of [QUERIES.GET_NODES_IMPACT, QUERIES.GET_NODES_TRANSITIVE_DEPENDENTS(4)]) {
      expect(run).toHaveBeenCalledWith(query, {
        nodeIds: ['file', 'interface', 'arrow', 'method'],
        projectId: 'proj_test',
        excludedFilePath: '/repo/feature.ts',
      });
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('shows separate important connections when one caller uses multiple symbols', async () => {
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      if (query === QUERIES.GET_NODES_IMPACT)
        return [
          dependent('caller'),
          dependent('caller', { targetNodeId: 'second', targetNodeName: 'saveFeature' }),
          dependent('caller'),
        ];
      return original(query, params);
    });
    const result = resultJson(await invoke({ filePath: '/repo/feature.ts', maxDepth: 1 }));
    expect(result.directDependents.count).toBe(1);
    expect(result.criticalPaths).toEqual([
      'caller (FunctionDeclaration) -[CALLS]-> runFeature (VariableDeclaration)',
      'caller (FunctionDeclaration) -[CALLS]-> saveFeature (VariableDeclaration)',
    ]);
  });

  it('reports an unindexed file as unknown without calculating a LOW risk score', async () => {
    run.mockResolvedValue([]);
    const response = await invoke({ filePath: '/repo/new.ts' });
    expect(response.content[0].text).toContain('not indexed');
    expect(response.content[0].text).toContain('Impact is unknown');
    expect(response.content[0].text).not.toContain('LOW');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not claim safety when an indexed file has no observed dependents', async () => {
    const result = resultJson(await invoke({ filePath: '/repo/feature.ts', maxDepth: 1 }));
    expect(result.summary).toContain('does not establish that it is safe');
    expect(result.analysis.riskBasis).toBe('relationship_heuristic');
    expect(result.transitiveDependents.count).toBe(0);
    expect(run.mock.calls.some(([query]) => query === QUERIES.GET_NODES_TRANSITIVE_DEPENDENTS(4))).toBe(false);
  });

  it('retains single-node analysis without excluding other symbols in that file', async () => {
    const result = resultJson(await invoke({ nodeId: 'arrow' }));
    expect(result.analysis).toMatchObject({ scope: 'node', analyzedNodeCount: 1 });
    expect(run).toHaveBeenCalledWith(QUERIES.GET_NODES_IMPACT, {
      nodeIds: ['arrow'],
      projectId: 'proj_test',
      excludedFilePath: null,
    });
  });
});
