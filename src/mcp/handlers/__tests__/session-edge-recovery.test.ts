import { describe, expect, it, vi } from 'vitest';

import { QUERIES } from '../../../storage/neo4j/neo4j.service.js';
import { recoverSessionEdges } from '../session-edge-recovery.helpers.js';

vi.mock('../../../core/utils/file-utils.js', () => ({ debugLog: vi.fn() }));

const recoveryRun = (projectPath: string | null) =>
  vi.fn(async (query: string) => {
    if (query.includes('MATCH (p:Project {projectId: $projectId})')) {
      return [{ projectId: 'proj_code', name: 'code', kind: 'codebase', path: projectPath }];
    }
    if (query === QUERIES.RECREATE_ABOUT_EDGES) return [{ recreated: 2 }];
    if (query === QUERIES.RECREATE_ABOUT_PATH_EDGES) return [{ recreated: 1 }];
    if (query === QUERIES.RECREATE_REFERENCES_EDGES) return [{ recreated: 4 }];
    if (query === QUERIES.RECREATE_REFERENCES_PATH_EDGES) return [{ recreated: 3 }];
    if (query === QUERIES.COUNT_STALE_ABOUT_REFS) return [{ staleCount: 5 }];
    return [{ recreated: 6 }];
  });

describe('session edge recovery after a reparse', () => {
  it('selects notes and bookmarks of any project by the reparsed project id prefix', () => {
    for (const query of [
      QUERIES.RECREATE_ABOUT_EDGES,
      QUERIES.RECREATE_REFERENCES_EDGES,
      QUERIES.COUNT_STALE_ABOUT_REFS,
    ]) {
      expect(query).toContain('STARTS WITH $projectIdPrefix');
      expect(query).toContain('projectId: $projectId})');
      expect(query).not.toMatch(/\((n|b):Session(Note|Bookmark) \{projectId/);
    }
  });

  it('relinks path anchors under the codebase root to its SourceFile nodes', () => {
    expect(QUERIES.RECREATE_ABOUT_PATH_EDGES).toContain('STARTS WITH $rootPrefix');
    expect(QUERIES.RECREATE_ABOUT_PATH_EDGES).toContain(
      'MATCH (file:SourceFile {projectId: $projectId, filePath: aboutPath})',
    );
    expect(QUERIES.RECREATE_REFERENCES_PATH_EDGES).toContain('STARTS WITH $rootPrefix');
    expect(QUERIES.RECREATE_REFERENCES_PATH_EDGES).toContain(
      'MATCH (file:SourceFile {projectId: $projectId, filePath: workingSetPath})',
    );
  });

  it('passes the id prefix and the root prefix, and adds node and path edges together', async () => {
    const run = recoveryRun('/work/code/');

    const result = await recoverSessionEdges({ run } as never, 'proj_code');

    expect(run).toHaveBeenCalledWith(QUERIES.RECREATE_ABOUT_PATH_EDGES, {
      projectId: 'proj_code',
      projectIdPrefix: 'proj_code:',
      rootPrefix: '/work/code/',
    });
    expect(result).toEqual({ aboutEdges: 3, referencesEdges: 7, marksEdges: 6, staleAboutRefs: 5 });
  });

  it('matches no path when the project has no directory', async () => {
    const run = recoveryRun(null);

    await recoverSessionEdges({ run } as never, 'proj_code');

    expect(run).toHaveBeenCalledWith(
      QUERIES.RECREATE_REFERENCES_PATH_EDGES,
      expect.objectContaining({ rootPrefix: null }),
    );
  });

  it('treats a failed project lookup as no path anchors and still runs the node-id recovery', async () => {
    const run = vi.fn(async (query: string) => {
      if (query.includes('MATCH (p:Project {projectId: $projectId})')) throw new Error('neo4j unavailable');
      if (query === QUERIES.RECREATE_ABOUT_EDGES) return [{ recreated: 2 }];
      return [{ recreated: 0, staleCount: 0 }];
    });

    const result = await recoverSessionEdges({ run } as never, 'proj_code');

    expect(result.aboutEdges).toBe(2);
    expect(run).toHaveBeenCalledWith(QUERIES.RECREATE_ABOUT_PATH_EDGES, expect.objectContaining({ rootPrefix: null }));
  });
});
