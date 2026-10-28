import { lstat, readFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve, sep } from 'path';

const PATH_INPUT_PATTERN = /^(\/|\.\/|\.\.\/|~|[a-zA-Z]:[\\/])/;

export interface GitLocation {
  /** Root of the repository the path belongs to; for a linked worktree, the main repository's root. */
  root: string;
  /** The input path, mapped to the same relative location under `root`. */
  path: string;
}

export const isPathInput = (input: string): boolean => PATH_INPUT_PATTERN.test(input);

/** Expands `~` and normalizes. Deliberately not realpath, which would change stored ids. */
export const normalizePath = (input: string): string => {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return resolve(input);
};

export const containsPath = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The path and each of its ancestors, each also with a trailing separator, in the forms a stored root may take. */
export const rootCandidates = (paths: readonly string[]): string[] => {
  const candidates = new Set<string>();
  for (const path of paths) {
    for (let directory = path; ; directory = dirname(directory)) {
      candidates.add(directory);
      if (!directory.endsWith(sep)) candidates.add(directory + sep);
      if (dirname(directory) === directory) break;
    }
  }
  return [...candidates];
};

export const pathBasename = (path: string): string => basename(normalizePath(path));

const readGitdirTarget = async (gitFile: string): Promise<string | null> => {
  const match = /^gitdir:\s*(.+)$/m.exec(await readFile(gitFile, 'utf-8'));
  return match ? resolve(dirname(gitFile), match[1].trim()) : null;
};

/** For a linked worktree's `.git` file, the main repository's root; null when the file is not a linked worktree. */
const mainRepositoryRoot = async (gitFile: string): Promise<string | null> => {
  try {
    const worktreeGitDir = await readGitdirTarget(gitFile);
    if (!worktreeGitDir) return null;
    const commonDir = resolve(worktreeGitDir, (await readFile(join(worktreeGitDir, 'commondir'), 'utf-8')).trim());
    return basename(commonDir) === '.git' ? dirname(commonDir) : null;
  } catch {
    return null;
  }
};

/**
 * The nearest ancestor with a `.git` entry, reading the files directly rather than running git.
 * A `.git` file that names a linked worktree resolves to the main repository, so every worktree
 * of a repository shares one project. A submodule's `.git` file has no `commondir` and stays its own root.
 */
export const findGitLocation = async (path: string): Promise<GitLocation | null> => {
  let directory = path;
  for (;;) {
    const entry = await lstat(join(directory, '.git')).catch(() => null);
    if (entry?.isDirectory()) return { root: directory, path };
    if (entry?.isFile()) {
      const mainRoot = await mainRepositoryRoot(join(directory, '.git'));
      return mainRoot ? { root: mainRoot, path: join(mainRoot, relative(directory, path)) } : { root: directory, path };
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
};

/** The package.json name, else the directory name. */
export const getProjectName = async (projectPath: string): Promise<string> => {
  const absolutePath = resolve(projectPath);
  try {
    const packageJson = JSON.parse(await readFile(join(absolutePath, 'package.json'), 'utf-8'));
    if (packageJson.name) return packageJson.name;
  } catch {
    // No readable package.json: use the directory name.
  }
  return basename(absolutePath);
};
