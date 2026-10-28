import { homedir } from 'os';
import { join } from 'path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  AmbiguousProjectError,
  InvalidProjectInputError,
  NotACodebaseError,
  ProjectNotFoundError,
} from '../project-errors.js';
import { CREATE_PROJECT_QUERY, ProjectService } from '../project.service.js';

import { makeDirectory, makeLinkedWorktree, makeRepository, makeTempRoot } from './git-fixtures.js';
import { createProjectStore, StoredProject, writesTo } from './project-store.fake.js';

const serviceOver = (projects: StoredProject[]) => {
  const store = createProjectStore(projects);
  return { service: new ProjectService(store), ...store };
};

describe('ProjectService resolution', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });

  describe('findProject by id and name', () => {
    const projects: StoredProject[] = [
      { projectId: 'proj_aaaaaaaaaaaa', name: 'agent-os', kind: 'codebase', path: '/work/agent-os' },
      { projectId: 'proj_bbbbbbbbbbbb', name: 'infra', kind: 'directory', path: '/work/infrastructure' },
      { projectId: 'proj_on-call', name: 'on-call', kind: 'collection', description: 'runbooks' },
    ];

    it('finds a project by exact id', async () => {
      const { service } = serviceOver(projects);

      expect((await service.findProject('proj_on-call')).name).toBe('on-call');
    });

    it('finds a project by exact name', async () => {
      const { service } = serviceOver(projects);

      expect((await service.findProject('agent-os')).projectId).toBe('proj_aaaaaaaaaaaa');
    });

    it('finds a project by the directory name of its registered path', async () => {
      const { service } = serviceOver(projects);

      expect((await service.findProject('infrastructure')).projectId).toBe('proj_bbbbbbbbbbbb');
    });

    it('fails on an id with a valid shape that does not exist, and lists what exists with the next call', async () => {
      const { service } = serviceOver(projects);

      const failure = service.findProject('proj_agentos');

      await expect(failure).rejects.toThrow(ProjectNotFoundError);
      await expect(failure).rejects.toThrow(/agent-os \(proj_aaaaaaaaaaaa, codebase, \/work\/agent-os\)/);
      await expect(failure).rejects.toThrow(/list_projects/);
    });

    it('reports a name shared by two projects as ambiguous, with both ids and paths', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_1', name: 'api', kind: 'codebase', path: '/a/api' },
        { projectId: 'proj_2', name: 'api', kind: 'directory', path: '/b/api' },
      ]);

      const failure = service.findProject('api');

      await expect(failure).rejects.toThrow(AmbiguousProjectError);
      await expect(failure).rejects.toThrow(/api \(proj_1, codebase, \/a\/api\); api \(proj_2, directory, \/b\/api\)/);
    });

    it('reports a directory name shared by two registered paths as ambiguous', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_1', name: 'one', kind: 'codebase', path: '/a/shared' },
        { projectId: 'proj_2', name: 'two', kind: 'directory', path: '/b/shared' },
      ]);

      await expect(service.findProject('shared')).rejects.toThrow(AmbiguousProjectError);
    });

    it('rejects an empty input', async () => {
      const { service } = serviceOver(projects);

      await expect(service.findProject('  ')).rejects.toThrow(InvalidProjectInputError);
    });
  });

  describe('findProject by path', () => {
    it('finds the project registered at exactly that path, with a trailing slash', async () => {
      const { service } = serviceOver([{ projectId: 'proj_1', name: 'repo', kind: 'codebase', path: '/work/repo' }]);

      expect((await service.findProject('/work/repo/')).projectId).toBe('proj_1');
    });

    it('resolves a path inside a codebase to that codebase', async () => {
      const { service } = serviceOver([{ projectId: 'proj_1', name: 'repo', kind: 'codebase', path: '/work/repo' }]);

      expect((await service.findProject('/work/repo/src/deep/file.ts')).projectId).toBe('proj_1');
    });

    it('takes the longest registered root that contains the path', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_outer', name: 'outer', kind: 'directory', path: '/work' },
        { projectId: 'proj_inner', name: 'inner', kind: 'codebase', path: '/work/repo' },
      ]);

      expect((await service.findProject('/work/repo/src')).projectId).toBe('proj_inner');
      expect((await service.findProject('/work/other')).projectId).toBe('proj_outer');
    });

    it('does not match agent-os-v2 against agent-os', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_1', name: 'agent-os', kind: 'codebase', path: '/work/agent-os' },
      ]);

      await expect(service.findProject('/work/agent-os-v2/src')).rejects.toThrow(ProjectNotFoundError);
    });

    it('expands ~ before matching', async () => {
      const { service } = serviceOver([
        { projectId: 'proj_1', name: 'home', kind: 'directory', path: join(homedir(), 'docs') },
      ]);

      expect((await service.findProject('~/docs/plans')).projectId).toBe('proj_1');
    });

    it('prefers a deeper git root over a registered non-git parent, and does not fall back to the parent', async () => {
      const parent = await makeDirectory(join(root, 'develop'));
      const repo = await makeRepository(join(parent, 'infrastructure'));
      const { service } = serviceOver([{ projectId: 'proj_parent', name: 'develop', kind: 'directory', path: parent }]);

      await expect(service.findProject(join(repo, 'terraform'))).rejects.toThrow(
        new RegExp(`inside the git repository ${repo}, which is not registered`),
      );
    });

    it('prefers a registered root over a shallower git root', async () => {
      const repo = await makeRepository(join(root, 'mono'));
      const package_ = await makeDirectory(join(repo, 'packages', 'api'));
      const { service } = serviceOver([{ projectId: 'proj_api', name: 'api', kind: 'directory', path: package_ }]);

      expect((await service.findProject(join(package_, 'src'))).projectId).toBe('proj_api');
    });

    it('resolves a path in a linked worktree to the main repository project', async () => {
      const main = await makeRepository(join(root, 'wt-main'));
      const worktree = await makeLinkedWorktree(main, join(root, 'wt-trees', 'feature'), 'feature');
      const { service } = serviceOver([{ projectId: 'proj_main', name: 'wt-main', kind: 'codebase', path: main }]);

      expect((await service.findProject(join(worktree, 'src'))).projectId).toBe('proj_main');
    });

    it('names the next call when the path is in no registered project and no repository', async () => {
      const loose = await makeDirectory(join(root, 'loose'));
      const { service } = serviceOver([]);

      const failure = service.findProject(loose);

      await expect(failure).rejects.toThrow(/not inside a registered project or a git repository/);
      await expect(failure).rejects.toThrow(/create_project/);
    });
  });

  describe('findOrRegisterProject', () => {
    it('registers the git root of a nested unregistered path as a directory', async () => {
      const repo = await makeRepository(join(root, 'reg-repo'));
      const nested = await makeDirectory(join(repo, 'docs', 'plans'));
      const { service, run } = serviceOver([]);

      const project = await service.findOrRegisterProject(nested);

      expect(project).toMatchObject({
        kind: 'directory',
        path: repo,
        name: 'reg-repo',
        projectId: expect.stringMatching(/^proj_[0-9a-f]{12}$/),
      });
      expect(writesTo(run, CREATE_PROJECT_QUERY)).toHaveLength(1);
    });

    it('registers the main repository, not the worktree, when none exists', async () => {
      const main = await makeRepository(join(root, 'reg-main'));
      const worktree = await makeLinkedWorktree(main, join(root, 'reg-trees', 'feature'), 'feature');
      const { service } = serviceOver([]);

      const project = await service.findOrRegisterProject(join(worktree, 'src'));

      expect(project.path).toBe(main);
    });

    it('registers nothing when a registered root already contains the path', async () => {
      const repo = await makeRepository(join(root, 'known-repo'));
      const { service, run } = serviceOver([{ projectId: 'proj_known', name: 'known', kind: 'codebase', path: repo }]);

      const project = await service.findOrRegisterProject(join(repo, 'src'));

      expect(project.projectId).toBe('proj_known');
      expect(writesTo(run, CREATE_PROJECT_QUERY)).toHaveLength(0);
    });

    it('fails without a git root or a registered root, and says to call create_project', async () => {
      const loose = await makeDirectory(join(root, 'no-git'));
      const { service } = serviceOver([]);

      await expect(service.findOrRegisterProject(loose)).rejects.toThrow(/create_project/);
    });

    it('never creates a project from a name or an id', async () => {
      const { service, run } = serviceOver([]);

      await expect(service.findOrRegisterProject('on-call')).rejects.toThrow(ProjectNotFoundError);
      await expect(service.findOrRegisterProject('proj_on-call')).rejects.toThrow(ProjectNotFoundError);
      expect(writesTo(run, CREATE_PROJECT_QUERY)).toHaveLength(0);
    });
  });

  describe('findCodebase', () => {
    it('returns a codebase', async () => {
      const { service } = serviceOver([{ projectId: 'proj_1', name: 'repo', kind: 'codebase', path: '/work/repo' }]);

      expect((await service.findCodebase('repo')).projectId).toBe('proj_1');
    });

    it('rejects a directory and says to parse it or read it with session_recall', async () => {
      const { service } = serviceOver([{ projectId: 'proj_1', name: 'infra', kind: 'directory', path: '/work/infra' }]);

      const failure = service.findCodebase('infra');

      await expect(failure).rejects.toThrow(NotACodebaseError);
      await expect(failure).rejects.toThrow(
        /is a directory.*parse_typescript_project on \/work\/infra.*session_recall/,
      );
    });

    it('rejects a collection and says to read it with session_recall', async () => {
      const { service } = serviceOver([{ projectId: 'proj_on-call', name: 'on-call', kind: 'collection' }]);

      await expect(service.findCodebase('on-call')).rejects.toThrow(/is a collection.*session_recall/);
    });
  });
});
