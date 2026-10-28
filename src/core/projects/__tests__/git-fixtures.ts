import { mkdir, mkdtemp, realpath, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export const makeTempRoot = async (): Promise<string> => realpath(await mkdtemp(join(tmpdir(), 'cgc-projects-')));

export const makeDirectory = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true });
  return path;
};

/** A repository root: a directory with a `.git` directory. */
export const makeRepository = async (path: string): Promise<string> => {
  await makeDirectory(join(path, '.git'));
  return path;
};

/** A linked worktree of `main`, laid out the way `git worktree add` writes it. */
export const makeLinkedWorktree = async (main: string, worktree: string, name: string): Promise<string> => {
  const worktreeGitDir = join(main, '.git', 'worktrees', name);
  await makeDirectory(worktreeGitDir);
  await writeFile(join(worktreeGitDir, 'commondir'), '../..\n');
  await makeDirectory(worktree);
  await writeFile(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
  return worktree;
};
