import { join } from 'path';

import { beforeAll, describe, expect, it } from 'vitest';

import { InvalidProjectInputError, NotACodebaseError } from '../project-errors.js';
import { CREATE_PROJECT_QUERY, ProjectService, UPSERT_CODEBASE_QUERY } from '../project.service.js';

import { makeDirectory, makeTempRoot } from './git-fixtures.js';
import { createProjectStore, StoredProject, writesTo } from './project-store.fake.js';

const serviceOver = (projects: StoredProject[]) => {
  const store = createProjectStore(projects);
  return { service: new ProjectService(store), ...store };
};

describe('ProjectService registration', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });

  describe('createCollection', () => {
    it('creates proj_<slug> with the description and no path', async () => {
      const { service, projects } = serviceOver([]);

      const { project, created } = await service.createCollection({
        name: 'setup_hyphae',
        description: 'Hyphae setup notes',
      });

      expect(created).toBe(true);
      expect(project).toMatchObject({
        projectId: 'proj_setup_hyphae',
        name: 'setup_hyphae',
        kind: 'collection',
        path: null,
        description: 'Hyphae setup notes',
      });
      expect(projects).toHaveLength(1);
    });

    it('is idempotent: an existing collection comes back unchanged with created false', async () => {
      const { service, run } = serviceOver([
        { projectId: 'proj_on-call', name: 'on-call', kind: 'collection', description: 'runbooks' },
      ]);

      const { project, created } = await service.createCollection({ name: 'on-call', description: 'something else' });

      expect(created).toBe(false);
      expect(project.description).toBe('runbooks');
      expect(writesTo(run, CREATE_PROJECT_QUERY)).toHaveLength(0);
    });

    it('fails and names the existing collection when a different name slugs to its id', async () => {
      const { service, run } = serviceOver([
        { projectId: 'proj_on-call', name: 'on-call', kind: 'collection', description: 'runbooks' },
      ]);

      await expect(service.createCollection({ name: 'On Call', description: 'other' })).rejects.toThrow(
        /'On Call' becomes collection id proj_on-call, which already belongs to the collection 'on-call'/,
      );
      expect(writesTo(run, CREATE_PROJECT_QUERY)).toHaveLength(0);
    });

    it('fails when two long names truncate to the same collection id', async () => {
      const prefix = 'quarterly-platform-reliability-review-notes';
      const { service } = serviceOver([
        {
          projectId: 'proj_quarterly-platform-reliability-review-no',
          name: `${prefix}-2025`,
          kind: 'collection',
          description: 'a',
        },
      ]);

      await expect(service.createCollection({ name: `${prefix}-2026`, description: 'b' })).rejects.toThrow(
        /already belongs to the collection 'quarterly-platform-reliability-review-notes-2025'/,
      );
    });

    it('fails when the id already belongs to a project of another kind', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_on-call', name: 'on-call', kind: 'directory', path: '/work/on-call' },
      ]);

      await expect(service.createCollection({ name: 'on-call', description: 'runbooks' })).rejects.toThrow(
        /already belongs to on-call \(proj_on-call, directory, \/work\/on-call\), which is not a collection/,
      );
    });

    it('fails when another project already has the name, so a name always picks one project', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_aaaaaaaaaaaa', name: 'agent-os', kind: 'codebase', path: '/work/agent-os' },
      ]);

      await expect(service.createCollection({ name: 'agent-os', description: 'notes' })).rejects.toThrow(
        /A project named 'agent-os' already exists/,
      );
    });

    it('requires a description', async () => {
      const { service } = serviceOver([]);

      await expect(service.createCollection({ name: 'on-call', description: ' ' })).rejects.toThrow(
        InvalidProjectInputError,
      );
    });

    it('rejects a name whose slug looks like a path hash', async () => {
      const { service } = serviceOver([]);

      await expect(service.createCollection({ name: 'a1b2c3d4e5f6', description: 'x' })).rejects.toThrow(
        /looks like the hash of a directory path/,
      );
    });
  });

  describe('registerDirectory', () => {
    it('registers an existing directory under the hash of its path, named after the directory', async () => {
      const directory = await makeDirectory(join(root, 'terraform'));
      const { service } = serviceOver([]);

      const { project, created } = await service.registerDirectory({ path: directory });

      expect(created).toBe(true);
      expect(project).toMatchObject({
        projectId: expect.stringMatching(/^proj_[0-9a-f]{12}$/),
        name: 'terraform',
        kind: 'directory',
        path: directory,
      });
    });

    it('rejects a path that does not exist', async () => {
      const { service } = serviceOver([]);

      await expect(service.registerDirectory({ path: join(root, 'missing') })).rejects.toThrow(
        /does not exist or is not a directory/,
      );
    });

    it('reuses the project already registered at the path under a non-hash id', async () => {
      const directory = await makeDirectory(join(root, 'runbench'));
      const { service, run } = serviceOver([
        { projectId: 'proj_1c2f3a931389', name: 'runbench', kind: 'codebase', path: directory },
      ]);

      const { project, created } = await service.registerDirectory({ path: `${directory}/` });

      expect(created).toBe(false);
      expect(project.projectId).toBe('proj_1c2f3a931389');
      expect(writesTo(run, CREATE_PROJECT_QUERY)).toHaveLength(0);
    });
  });

  describe('chooseCodebaseId (the parse path)', () => {
    it('reuses the id registered at the path even when it is not the hash of the path', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_1c2f3a931389', name: 'runbench', kind: 'codebase', path: '/work/runbench' },
      ]);

      expect(await service.chooseCodebaseId('/work/runbench')).toBe('proj_1c2f3a931389');
    });

    it('reuses the id of a directory registered at the path, so parsing keeps its notes', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_dddddddddddd', name: 'infra', kind: 'directory', path: '/work/infra' },
      ]);

      expect(await service.chooseCodebaseId('/work/infra')).toBe('proj_dddddddddddd');
    });

    it('mints the path hash only for a path nothing is registered at', async () => {
      const { service } = serviceOver([{ projectId: 'proj_1', name: 'repo', kind: 'codebase', path: '/work/repo' }]);

      expect(await service.chooseCodebaseId('/work/repo/packages/api')).toBe('proj_feda3b688a17');
    });

    it('lets an explicit projectId win over the registered one', async () => {
      const { service } = serviceOver([{ projectId: 'proj_1', name: 'repo', kind: 'codebase', path: '/work/repo' }]);

      expect(await service.chooseCodebaseId('/work/repo', 'proj_custom')).toBe('proj_custom');
    });

    it('rejects an explicit id with an invalid shape', async () => {
      const { service } = serviceOver([]);

      await expect(service.chooseCodebaseId('/work/repo', 'Custom')).rejects.toThrow(InvalidProjectInputError);
    });

    it('rejects an explicit id that belongs to a collection', async () => {
      const { service } = serviceOver([{ projectId: 'proj_on-call', name: 'on-call', kind: 'collection' }]);

      await expect(service.chooseCodebaseId('/work/repo', 'proj_on-call')).rejects.toThrow(NotACodebaseError);
    });
  });

  describe('lookups for the ingestors', () => {
    it('maps each exact path to its registered id and skips unregistered paths', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_1c2f3a931389', name: 'runbench', kind: 'codebase', path: '/work/runbench' },
      ]);

      const ids = await service.findProjectIdsByPath(['/work/runbench/', '/work/other']);

      expect([...ids]).toEqual([['/work/runbench', 'proj_1c2f3a931389']]);
    });

    it('lists the ids that have no Project node', async () => {
      const { service } = serviceOver([{ projectId: 'proj_known', name: 'known', kind: 'collection' }]);

      expect(await service.findUnregisteredIds(['proj_known', 'proj_typo'])).toEqual(['proj_typo']);
    });
  });

  describe('list', () => {
    it('maps rows to projects with memory counts and the latest save time', async () => {
      const { service, run } = serviceOver([
        { projectId: 'proj_on-call', name: 'on-call', kind: 'collection', description: 'runbooks' },
        { projectId: 'proj_1', name: 'repo', kind: 'codebase', path: '/work/repo', status: 'complete' },
      ]);

      const listed = await service.list(['collection']);

      expect(listed).toEqual([
        {
          projectId: 'proj_on-call',
          name: 'on-call',
          kind: 'collection',
          path: null,
          description: 'runbooks',
          status: null,
          nodeCount: null,
          edgeCount: null,
          updatedAt: null,
          memory: { liveNotes: 2, bookmarks: 1, lastSavedAt: '2023-11-14T22:21:40.000Z' },
        },
      ]);
      expect(run.mock.calls[0][1]).toEqual({ kinds: ['collection'] });
    });

    it('lists every kind by default', async () => {
      const { service, run } = serviceOver([]);

      await service.list();

      expect(run.mock.calls[0][1]).toEqual({ kinds: ['codebase', 'directory', 'collection'] });
    });
  });

  describe('parse writes', () => {
    it('upserts a codebase with a normalized path', async () => {
      const { service, run } = serviceOver([]);

      await service.upsertCodebase({ projectId: 'proj_1', name: 'repo', path: '/work/repo/', status: 'parsing' });

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toBe(UPSERT_CODEBASE_QUERY);
      expect(run.mock.calls[0][1]).toEqual({
        projectId: 'proj_1',
        name: 'repo',
        path: '/work/repo',
        status: 'parsing',
      });
    });
  });

  describe('backfillKinds', () => {
    it('returns the count of nodes it changed', async () => {
      const store = createProjectStore([]);
      store.run.mockResolvedValueOnce([{ backfilled: { toNumber: () => 6 } }]);

      expect(await new ProjectService(store).backfillKinds()).toBe(6);
    });
  });
});
