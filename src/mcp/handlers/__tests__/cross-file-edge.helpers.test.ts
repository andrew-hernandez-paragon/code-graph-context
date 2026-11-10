import neo4j from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import { QUERIES } from '../../../storage/neo4j/neo4j.service.js';
import {
  loadExistingNodesForEdgeDetection,
  restoreIncomingEdges,
  saveIncomingEdges,
} from '../cross-file-edge.helpers.js';

const EDGE = {
  startNodeId: 'proj_code:FunctionDeclaration:caller',
  startFilePath: '/work/code/caller.ts',
  endNodeId: 'proj_code:FunctionDeclaration:callee',
  edgeType: 'CALLS',
  edgeProperties: { lineNumber: 12 },
};

describe('incoming edges of files being reparsed', () => {
  it('selects edges that end in the files and start outside them', () => {
    expect(QUERIES.GET_INCOMING_EDGES).toContain('target.filePath IN $filePaths');
    expect(QUERIES.GET_INCOMING_EDGES).toContain('MATCH (source:GraphNode)-[r]->(target)');
    expect(QUERIES.GET_INCOMING_EDGES).toContain('NOT source.filePath IN $filePaths');
  });

  it('saves the edges Neo4j returns for the given files', async () => {
    const run = vi.fn(async () => [EDGE]);

    const saved = await saveIncomingEdges({ run } as never, ['/work/code/callee.ts'], 'proj_code');

    expect(run).toHaveBeenCalledWith(QUERIES.GET_INCOMING_EDGES, {
      filePaths: ['/work/code/callee.ts'],
      projectId: 'proj_code',
    });
    expect(saved).toEqual([EDGE]);
  });

  it('restores the saved edges and reports how many matched both ends', async () => {
    const run = vi.fn(async () => [{ restoredCount: neo4j.int(1) }]);

    const restored = await restoreIncomingEdges({ run } as never, [EDGE], 'proj_code');

    expect(run).toHaveBeenCalledWith(QUERIES.RESTORE_INCOMING_EDGES, { edges: [EDGE], projectId: 'proj_code' });
    expect(restored).toBe(1);
  });

  it('runs no query when there is nothing to restore', async () => {
    const run = vi.fn();

    expect(await restoreIncomingEdges({ run } as never, [], 'proj_code')).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('existing nodes for edge resolution', () => {
  it('carries the class a method belongs to, so a call resolves by receiver type', async () => {
    const run = vi.fn(async () => [
      {
        id: 'proj_code:MethodDeclaration:run',
        name: 'run',
        coreType: 'MethodDeclaration',
        semanticType: null,
        labels: ['Method'],
        filePath: '/work/code/service.ts',
        parentClassName: 'Service',
      },
    ]);

    const nodes = await loadExistingNodesForEdgeDetection({ run } as never, ['/work/code/caller.ts'], 'proj_code');

    expect(run).toHaveBeenCalledWith(QUERIES.GET_EXISTING_NODES_FOR_EDGE_DETECTION, {
      excludeFilePaths: ['/work/code/caller.ts'],
      projectId: 'proj_code',
    });
    expect(nodes).toEqual([
      {
        id: 'proj_code:MethodDeclaration:run',
        labels: ['Method'],
        properties: {
          id: 'proj_code:MethodDeclaration:run',
          projectId: 'proj_code',
          name: 'run',
          coreType: 'MethodDeclaration',
          semanticType: undefined,
          filePath: '/work/code/service.ts',
          parentClassName: 'Service',
        },
      },
    ]);
  });
});
