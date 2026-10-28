import { describe, expect, it, vi } from 'vitest';

import {
  COUNT_PROJECT_NODES_QUERY,
  COUNT_SCOPED_DELIBERATIONS_QUERY,
  COUNT_UNRESOLVABLE_ANCHORS_QUERY,
  DELETE_PROJECT_NODES_QUERY,
  MOVE_MEMORY_QUERY,
  ProjectDeletionService,
  RESCOPE_DELIBERATIONS_QUERY,
  UNSCOPE_DELIBERATIONS_QUERY,
} from '../project-deletion.service.js';
import { InvalidProjectInputError, ProjectDeletionRefusedError } from '../project-errors.js';
import { DELETE_PROJECT_QUERY, ProjectService } from '../project.service.js';

import { createProjectStore, writesTo } from './project-store.fake.js';

const OLD_ID = 'proj_old';
const COLLECTION_ID = 'proj_workflow';

const MEMORY_AND_CODE = [
  { labels: ['SessionNote'], count: 3 },
  { labels: ['SessionNoteChunk'], count: 5 },
  { labels: ['SessionBookmark'], count: 1 },
  { labels: ['GraphNode', 'Function'], count: 40 },
  { labels: ['Project'], count: 1 },
];
const CODE_ONLY = MEMORY_AND_CODE.slice(3);

const serviceWith = (nodeCounts: { labels: string[]; count: number }[]) => {
  const store = createProjectStore([
    { projectId: OLD_ID, name: 'old-repo', kind: 'codebase', path: '/work/old-repo' },
    { projectId: COLLECTION_ID, name: 'workflow', kind: 'collection' },
  ]);
  const answers = new Map<string, Record<string, unknown>[]>([
    [COUNT_PROJECT_NODES_QUERY, nodeCounts],
    [COUNT_SCOPED_DELIBERATIONS_QUERY, [{ count: 6 }]],
    [COUNT_UNRESOLVABLE_ANCHORS_QUERY, [{ aboutNodeIds: 7, workingSetNodeIds: 2 }]],
    [DELETE_PROJECT_NODES_QUERY, [{ total: 41, failedBatches: 0, errorMessages: {} }]],
  ]);
  const run = vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
    const answer = answers.get(query);
    return answer ?? store.run(query, params);
  });
  return { service: new ProjectDeletionService(new ProjectService({ run }), { run }), run };
};

describe('ProjectDeletionService', () => {
  describe('planDeletion', () => {
    it('refuses a project that holds memory when neither flag is given, naming the counts and both flags', async () => {
      const { service } = serviceWith(MEMORY_AND_CODE);

      const refusal = service.planDeletion(OLD_ID, {});

      await expect(refusal).rejects.toBeInstanceOf(ProjectDeletionRefusedError);
      await expect(refusal).rejects.toThrow(
        /3 SessionNote, 5 SessionNoteChunk, 1 SessionBookmark.*--move-memory-to <project>.*--delete-memory/,
      );
    });

    it('lets a project without memory be deleted with no flag', async () => {
      const { service } = serviceWith(CODE_ONLY);

      const plan = await service.planDeletion(OLD_ID, {});

      expect(plan.moved).toEqual({});
      expect(plan.deleted).toEqual({ 'Function:GraphNode': 40, Project: 1 });
    });

    it('moves the memory labels and deletes the rest when a target is given', async () => {
      const { service } = serviceWith(MEMORY_AND_CODE);

      const plan = await service.planDeletion(OLD_ID, { moveMemoryTo: 'workflow' });

      expect(plan.target?.projectId).toBe(COLLECTION_ID);
      expect(plan.moved).toEqual({ SessionNote: 3, SessionNoteChunk: 5, SessionBookmark: 1 });
      expect(plan.deleted).toEqual({ 'Function:GraphNode': 40, Project: 1 });
      expect(plan.deliberations).toBe(6);
      expect(plan.prunedAnchors).toEqual({ aboutNodeIds: 7, workingSetNodeIds: 2 });
    });

    it('deletes the memory with the project when --delete-memory is given', async () => {
      const { service } = serviceWith(MEMORY_AND_CODE);

      const plan = await service.planDeletion(OLD_ID, { deleteMemory: true });

      expect(plan.target).toBeNull();
      expect(plan.moved).toEqual({});
      expect(plan.deleted).toMatchObject({ SessionNote: 3, SessionNoteChunk: 5, SessionBookmark: 1 });
    });

    it('rejects a target that is the project itself, and both memory flags together', async () => {
      const { service } = serviceWith(MEMORY_AND_CODE);

      await expect(service.planDeletion(OLD_ID, { moveMemoryTo: '/work/old-repo' })).rejects.toBeInstanceOf(
        InvalidProjectInputError,
      );
      await expect(service.planDeletion(OLD_ID, { moveMemoryTo: 'workflow', deleteMemory: true })).rejects.toThrow(
        'not both',
      );
    });

    it('writes nothing while planning', async () => {
      const { service, run } = serviceWith(MEMORY_AND_CODE);

      await service.planDeletion(OLD_ID, { moveMemoryTo: 'workflow' });

      const written = [
        MOVE_MEMORY_QUERY,
        RESCOPE_DELIBERATIONS_QUERY,
        UNSCOPE_DELIBERATIONS_QUERY,
        DELETE_PROJECT_NODES_QUERY,
        DELETE_PROJECT_QUERY,
      ];
      for (const query of written) expect(writesTo(run, query)).toHaveLength(0);
    });
  });

  describe('executeDeletion', () => {
    it('moves memory with the id prefix to prune, re-scopes deliberations, then deletes nodes and the Project in that order', async () => {
      const { service, run } = serviceWith(MEMORY_AND_CODE);
      const plan = await service.planDeletion(OLD_ID, { moveMemoryTo: 'workflow' });
      run.mockClear();

      await service.executeDeletion(plan);

      expect(run.mock.calls.map(([query]) => query)).toEqual([
        MOVE_MEMORY_QUERY,
        RESCOPE_DELIBERATIONS_QUERY,
        DELETE_PROJECT_NODES_QUERY,
        DELETE_PROJECT_QUERY,
      ]);
      expect(run).toHaveBeenNthCalledWith(1, MOVE_MEMORY_QUERY, {
        projectId: 'proj_old',
        idPrefix: 'proj_old:',
        targetProjectId: 'proj_workflow',
      });
      expect(run).toHaveBeenNthCalledWith(2, RESCOPE_DELIBERATIONS_QUERY, {
        projectId: 'proj_old',
        idPrefix: 'proj_old:',
        targetProjectId: 'proj_workflow',
      });
      expect(run).toHaveBeenNthCalledWith(4, DELETE_PROJECT_QUERY, { projectId: 'proj_old' });
    });

    it('removes the id from deliberations and moves nothing when the memory is deleted', async () => {
      const { service, run } = serviceWith(MEMORY_AND_CODE);
      const plan = await service.planDeletion(OLD_ID, { deleteMemory: true });
      run.mockClear();

      await service.executeDeletion(plan);

      expect(run.mock.calls.map(([query]) => query)).toEqual([
        UNSCOPE_DELIBERATIONS_QUERY,
        DELETE_PROJECT_NODES_QUERY,
        DELETE_PROJECT_QUERY,
      ]);
    });

    it('keeps the Project when a deletion batch failed, so the command can be run again', async () => {
      const { service, run } = serviceWith(CODE_ONLY);
      const plan = await service.planDeletion(OLD_ID, {});
      run.mockImplementation(async (query) =>
        query === DELETE_PROJECT_NODES_QUERY ? [{ total: 0, failedBatches: 1, errorMessages: { boom: 1 } }] : [],
      );

      await expect(service.executeDeletion(plan)).rejects.toThrow('failed: {"boom":1}');
      expect(writesTo(run, DELETE_PROJECT_QUERY)).toHaveLength(0);
    });
  });
});

describe('deliberation and anchor Cypher', () => {
  it('prunes only node ids that start with the deleted project prefix and leaves aboutPaths alone', () => {
    expect(MOVE_MEMORY_QUERY).toContain('NOT id STARTS WITH $idPrefix');
    expect(MOVE_MEMORY_QUERY).not.toContain('aboutPaths');
  });

  it('replaces the id with the target without duplicates and scopes the deliberation to the target', () => {
    expect(RESCOPE_DELIBERATIONS_QUERY).toContain('MERGE (d)-[:SCOPED_TO]->(target)');
    expect(RESCOPE_DELIBERATIONS_QUERY).toContain('$targetProjectId IN ids THEN ids');
  });
});
