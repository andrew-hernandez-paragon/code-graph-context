import { describe, expect, it, vi } from 'vitest';

import { ProjectDeletionRefusedError, type ProjectDeletionPlan } from '../../core/projects/index.js';
import { runProjectDelete, type ProjectDeleteDependencies } from '../project-delete.js';

const plan: ProjectDeletionPlan = {
  project: {
    projectId: 'proj_old',
    name: 'old-repo',
    kind: 'codebase',
    path: '/work/old-repo',
    description: null,
    status: 'complete',
    nodeCount: null,
    edgeCount: null,
    embeddingModel: null,
    embeddingDimensions: null,
    updatedAt: null,
  },
  target: {
    projectId: 'proj_new',
    name: 'new-repo',
    kind: 'codebase',
    path: '/work/new-repo',
    description: null,
    status: 'complete',
    nodeCount: null,
    edgeCount: null,
    embeddingModel: null,
    embeddingDimensions: null,
    updatedAt: null,
  },
  moved: { SessionNote: 3, SessionBookmark: 1 },
  deleted: { 'Function:GraphNode': 40, Project: 1 },
  deliberations: 6,
  prunedAnchors: { aboutNodeIds: 7, workingSetNodeIds: 2 },
};

const harness = (confirmed = true) => {
  const out: string[] = [];
  const err: string[] = [];
  const deletion = {
    planDeletion: vi.fn(async () => plan),
    executeDeletion: vi.fn(async () => undefined),
  };
  const confirm = vi.fn(async () => confirmed);
  const deps: ProjectDeleteDependencies = {
    deletion,
    confirm,
    writeStdout: (line) => out.push(line),
    writeStderr: (line) => err.push(line),
  };
  return { deps, deletion, confirm, out, err };
};

describe('runProjectDelete', () => {
  it('prints per-label counts on a dry run and writes nothing', async () => {
    const { deps, deletion, confirm, out } = harness();

    const code = await runProjectDelete('proj_old', { moveMemoryTo: 'proj_new', dryRun: true }, deps);

    expect(code).toBe(0);
    expect(deletion.executeDeletion).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(out.join('\n')).toBe(
      [
        'Dry run, nothing was written.',
        'Project: old-repo (proj_old, codebase)',
        'Memory moves to: new-repo (proj_new)',
        'Nodes moved:',
        '  SessionNote: 3',
        '  SessionBookmark: 1',
        '  anchors pruned (ids into proj_old): 7 aboutNodeIds, 2 workingSetNodeIds',
        'Deliberations re-scoped to the target: 6',
        'Nodes deleted:',
        '  Function:GraphNode: 40',
        '  Project: 1',
      ].join('\n'),
    );
  });

  it('asks for confirmation and deletes when the operator agrees', async () => {
    const { deps, deletion, confirm } = harness(true);

    expect(await runProjectDelete('proj_old', {}, deps)).toBe(0);

    expect(confirm).toHaveBeenCalledWith('Delete project proj_old? This cannot be undone.');
    expect(deletion.executeDeletion).toHaveBeenCalledWith(plan);
  });

  it('writes nothing when the operator declines', async () => {
    const { deps, deletion, out } = harness(false);

    expect(await runProjectDelete('proj_old', {}, deps)).toBe(0);

    expect(deletion.executeDeletion).not.toHaveBeenCalled();
    expect(out.at(-1)).toBe('Cancelled, nothing was written.');
  });

  it('skips the prompt with --yes', async () => {
    const { deps, deletion, confirm } = harness();

    await runProjectDelete('proj_old', { yes: true }, deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(deletion.executeDeletion).toHaveBeenCalledOnce();
  });

  it('prints a refusal to stderr and exits 1', async () => {
    const { deps, deletion, err } = harness();
    deletion.planDeletion.mockRejectedValue(new ProjectDeletionRefusedError('holds memory: pass a flag'));

    expect(await runProjectDelete('proj_old', {}, deps)).toBe(1);

    expect(err).toEqual(['holds memory: pass a flag']);
    expect(deletion.executeDeletion).not.toHaveBeenCalled();
  });
});
