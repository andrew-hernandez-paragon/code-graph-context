import { createHash } from 'crypto';
import { open, stat } from 'fs/promises';
import { isAbsolute, resolve } from 'path';

import { InvalidProjectInputError, normalizePath } from '../projects/index.js';

/** A file larger than this is hashed by its first bytes only, and the save result says so. */
export const MAX_HASHED_FILE_BYTES = 5 * 1024 * 1024;

export interface AnchorPathOwner {
  projectId: string;
  name: string;
  path: string | null;
}

export interface AnchorFingerprint {
  path: string;
  state: 'missing' | 'directory' | 'file';
  /** Empty unless the path is a file. */
  hash: string;
  /** True when the file exceeded MAX_HASHED_FILE_BYTES and only its first bytes were hashed. */
  partial: boolean;
}

/**
 * Absolute, deduplicated anchor paths. `~` expands, absolute paths stay, relative paths resolve against
 * the project's directory. A collection has no directory, so a relative path there is an error.
 */
export const normalizeAnchorPaths = (paths: readonly string[], owner: AnchorPathOwner): string[] => {
  const normalized = paths.map((raw) => {
    const path = raw.trim();
    if (path.length === 0) {
      throw new InvalidProjectInputError(
        'An anchor path is empty. Pass an absolute path, a ~/ path or a relative path.',
      );
    }
    if (path.startsWith('~') || isAbsolute(path)) return normalizePath(path);
    if (owner.path === null) {
      throw new InvalidProjectInputError(
        `Path '${path}' is relative, but project '${owner.name}' (${owner.projectId}) is a collection with no directory to resolve it against. Pass an absolute path or a ~/ path.`,
      );
    }
    return resolve(normalizePath(owner.path), path);
  });
  return [...new Set(normalized)];
};

const pathExists = async (path: string): Promise<boolean> => (await stat(path).catch(() => null)) !== null;

const fingerprintPath = async (path: string): Promise<AnchorFingerprint> => {
  // A path that cannot be read counts as missing: the anchor can no longer be checked.
  const stats = await stat(path).catch(() => null);
  if (!stats) return { path, state: 'missing', hash: '', partial: false };
  if (!stats.isFile()) return { path, state: 'directory', hash: '', partial: false };

  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(stats.size, MAX_HASHED_FILE_BYTES));
    await handle.read(bytes, 0, bytes.length, 0);
    return {
      path,
      state: 'file',
      hash: createHash('sha256').update(bytes).digest('hex'),
      partial: stats.size > MAX_HASHED_FILE_BYTES,
    };
  } finally {
    await handle.close();
  }
};

export const fingerprintAnchorPaths = (paths: readonly string[]): Promise<AnchorFingerprint[]> =>
  Promise.all(paths.map(fingerprintPath));

/** Paths that do not exist, checked without reading file contents. */
export const findMissingAnchorPaths = async (paths: readonly string[]): Promise<string[]> => {
  const exists = await Promise.all(paths.map(pathExists));
  return paths.filter((_, index) => !exists[index]);
};

export const missingPathsOf = (fingerprints: readonly AnchorFingerprint[]): string[] =>
  fingerprints.filter(({ state }) => state === 'missing').map(({ path }) => path);

/**
 * Files whose content differs from the hash stored at save time. A stored empty hash means the path was
 * a folder or absent then, so there is nothing to compare against.
 */
export const changedPathsOf = (fingerprints: readonly AnchorFingerprint[], storedHashes: readonly string[]): string[] =>
  fingerprints
    .filter(({ state, hash }, index) => state === 'file' && !!storedHashes[index] && storedHashes[index] !== hash)
    .map(({ path }) => path);
