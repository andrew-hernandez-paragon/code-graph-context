import { writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  containsPath,
  findGitLocation,
  getProjectName,
  isPathInput,
  normalizePath,
  rootCandidates,
} from '../project-paths.js';

import { makeDirectory, makeLinkedWorktree, makeRepository, makeTempRoot } from './git-fixtures.js';

describe('isPathInput', () => {
  it.each([
    ['/abs/path', true],
    ['./rel', true],
    ['../rel', true],
    ['~/dir', true],
    ['~', true],
    ['C:\\work\\repo', true],
    ['D:/work/repo', true],
    ['agent-os', false],
    ['proj_a1b2c3d4e5f6', false],
  ])('%s -> %s', (input, expected) => {
    expect(isPathInput(input)).toBe(expected);
  });
});

describe('normalizePath', () => {
  it('expands ~ and drops a trailing slash', () => {
    expect(normalizePath('~/develop/')).toBe(join(homedir(), 'develop'));
    expect(normalizePath('~')).toBe(homedir());
  });

  it('collapses .. segments', () => {
    expect(normalizePath('/work/repo/../agent-os')).toBe('/work/agent-os');
  });
});

describe('containsPath', () => {
  it('matches the root itself and paths below it', () => {
    expect(containsPath('/work/agent-os', '/work/agent-os')).toBe(true);
    expect(containsPath('/work/agent-os', '/work/agent-os/src/a.ts')).toBe(true);
  });

  it('does not match a sibling that shares a name prefix', () => {
    expect(containsPath('/work/agent-os', '/work/agent-os-v2/src')).toBe(false);
  });

  it('treats the filesystem root as containing everything', () => {
    expect(containsPath('/', '/work')).toBe(true);
  });
});

describe('findGitLocation', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });

  it('finds the nearest ancestor with a .git directory', async () => {
    const repo = await makeRepository(join(root, 'repo'));
    const nested = await makeDirectory(join(repo, 'packages', 'api'));

    expect(await findGitLocation(nested)).toEqual({ root: repo, path: nested });
  });

  it('prefers the nearest repository over an outer one', async () => {
    const outer = await makeRepository(join(root, 'outer'));
    const inner = await makeRepository(join(outer, 'inner'));

    expect(await findGitLocation(join(inner, 'src'))).toEqual({ root: inner, path: join(inner, 'src') });
  });

  it('returns null outside any repository', async () => {
    const loose = await makeDirectory(join(root, 'loose', 'dir'));

    expect(await findGitLocation(loose)).toBeNull();
  });

  it('maps a path in a linked worktree to the same relative path under the main repository', async () => {
    const main = await makeRepository(join(root, 'main'));
    const worktree = await makeLinkedWorktree(main, join(root, 'trees', 'feature'), 'feature');

    expect(await findGitLocation(join(worktree, 'src', 'deep'))).toEqual({
      root: main,
      path: join(main, 'src', 'deep'),
    });
  });

  it('keeps a submodule, whose .git file has no commondir, as its own root', async () => {
    const submodule = await makeDirectory(join(root, 'super', 'sub'));
    await writeFile(join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n');

    expect(await findGitLocation(join(submodule, 'src'))).toEqual({ root: submodule, path: join(submodule, 'src') });
  });
});

describe('rootCandidates', () => {
  it('lists a path and each ancestor, with and without a trailing separator', () => {
    expect(rootCandidates(['/work/repo/src'])).toEqual([
      '/work/repo/src',
      '/work/repo/src/',
      '/work/repo',
      '/work/repo/',
      '/work',
      '/work/',
      '/',
    ]);
  });

  it('lists a shared ancestor once', () => {
    const candidates = rootCandidates(['/work/a', '/work/b']);

    expect(candidates.filter((candidate) => candidate === '/work')).toHaveLength(1);
  });
});

describe('getProjectName', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });

  it('reads the name from package.json', async () => {
    const directory = await makeDirectory(join(root, 'named'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@scope/named-package' }));

    expect(await getProjectName(directory)).toBe('@scope/named-package');
  });

  it('uses the directory name when package.json is missing or has no name', async () => {
    const noFile = await makeDirectory(join(root, 'no-file'));
    const noName = await makeDirectory(join(root, 'no-name'));
    await writeFile(join(noName, 'package.json'), '{}');

    expect(await getProjectName(noFile)).toBe('no-file');
    expect(await getProjectName(noName)).toBe('no-name');
  });
});
