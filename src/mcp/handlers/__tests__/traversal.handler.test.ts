import { describe, expect, it, vi } from 'vitest';
import type { Neo4jService } from '../../../storage/neo4j/neo4j.service.js';
import { TraversalHandler } from '../traversal.handler.js';

vi.mock('../../utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils.js')>()),
  debugLog: vi.fn(),
}));
const handlerWith = (run: ReturnType<typeof vi.fn>) => new TraversalHandler({ run } as unknown as Neo4jService);

const node = (id: string) => ({ id, labels: ['Function'], properties: { id, name: id, filePath: `/repo/${id}.ts` } });

describe('file resolution', () => {
  it('never substitutes an indexed namesake for an absent absolute path', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ nodeId: 'wrong-file' }]);
    expect(await handlerWith(run).resolveNodeIdFromFilePath('/repo/new/index.ts', 'proj_test')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('matches the full relative suffix and retains project scope', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ nodeId: 'right-file' }]);
    expect(await handlerWith(run).resolveNodeIdFromFilePath('./src/feature.ts', 'proj_test')).toBe('right-file');
    expect(run.mock.calls[1][1]).toEqual({
      filePath: '/src/feature.ts',
      relativePath: 'src/feature.ts',
      projectId: 'proj_test',
    });
    expect(run.mock.calls[1][0]).not.toContain('$fileName');
  });

  it('asks for a more specific path when a basename is ambiguous', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { nodeId: 'a', filePath: '/repo/a/index.ts' },
        { nodeId: 'b', filePath: '/repo/b/index.ts' },
      ]);
    await expect(handlerWith(run).resolveNodeIdFromFilePath('index.ts', 'proj_test')).rejects.toThrow(
      'Ambiguous file path',
    );
  });
});

describe('weighted traversal', () => {
  it.each([false, true])(
    'retains connections and discloses incompatible-vector ranking (summary=%s)',
    async (summaryOnly) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce([{ n: node('start') }])
        .mockResolvedValueOnce([
          {
            result: {
              node: node('caller'),
              sourceNodeId: 'start',
              relationship: { type: 'CALLS', startNodeId: 'caller', endNodeId: 'start', properties: {} },
              scoring: { embeddingStatus: 'dimension_mismatch', combinedScore: 0.4 },
            },
          },
        ]);
      const response = await handlerWith(run).traverseFromNode('start', [0.1, 0.2], {
        projectId: 'proj_test',
        useWeightedTraversal: true,
        maxDepth: 1,
        summaryOnly,
        relationshipTypes: ['CALLS'],
      });
      const result = JSON.parse(response.content[0].text);
      expect(result.ranking.embeddingFallbacks).toEqual({ dimension_mismatch: 1 });
      expect(result.warnings[0]).toContain('1 traversed nodes');
      expect(JSON.stringify(result)).toContain('caller.ts');
      expect(run.mock.calls[1][1].relationshipTypes).toEqual(['CALLS']);
    },
  );
});
