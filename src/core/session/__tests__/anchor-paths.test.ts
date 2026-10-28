import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  changedPathsOf,
  findMissingAnchorPaths,
  fingerprintAnchorPaths,
  MAX_HASHED_FILE_BYTES,
  missingPathsOf,
  normalizeAnchorPaths,
} from '../anchor-paths.js';

const SHA256_OF_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

describe('normalizeAnchorPaths', () => {
  const codebase = { projectId: 'proj_code', name: 'code', path: '/work/code' };
  const collection = { projectId: 'proj_notes', name: 'notes', path: null };

  it('expands ~, keeps absolute paths and resolves relative paths against the project directory', () => {
    expect(normalizeAnchorPaths(['~/docs/a.md', '/etc/hosts', 'src/index.ts', './src/../lib/b.ts'], codebase)).toEqual([
      join(homedir(), 'docs/a.md'),
      '/etc/hosts',
      '/work/code/src/index.ts',
      '/work/code/lib/b.ts',
    ]);
  });

  it('removes duplicates after normalizing', () => {
    expect(normalizeAnchorPaths(['src/a.ts', '/work/code/src/a.ts'], codebase)).toEqual(['/work/code/src/a.ts']);
  });

  it('accepts absolute and ~ paths in a collection', () => {
    expect(normalizeAnchorPaths(['/etc/hosts', '~'], collection)).toEqual(['/etc/hosts', homedir()]);
  });

  it('rejects a relative path in a collection and names the project and the fix', () => {
    expect(() => normalizeAnchorPaths(['src/a.ts'], collection)).toThrow(
      "Path 'src/a.ts' is relative, but project 'notes' (proj_notes) is a collection with no directory to resolve it against. Pass an absolute path or a ~/ path.",
    );
  });

  it('rejects an empty path', () => {
    expect(() => normalizeAnchorPaths(['  '], codebase)).toThrow('An anchor path is empty.');
  });
});

describe('fingerprinting anchor paths', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'anchor-paths-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('hashes a file, leaves a folder empty and reports a missing path', async () => {
    const file = join(directory, 'a.txt');
    const folder = join(directory, 'folder');
    const missing = join(directory, 'gone.txt');
    await writeFile(file, 'hello');
    await mkdir(folder);

    const fingerprints = await fingerprintAnchorPaths([file, folder, missing]);

    expect(fingerprints.map(({ state, hash }) => [state, hash])).toEqual([
      ['file', SHA256_OF_HELLO],
      ['directory', ''],
      ['missing', ''],
    ]);
    expect(missingPathsOf(fingerprints)).toEqual([missing]);
  });

  it('lists missing paths by existence alone, counting a folder as present', async () => {
    const file = join(directory, 'a.txt');
    const folder = join(directory, 'folder');
    const missing = join(directory, 'gone.txt');
    await writeFile(file, 'hello');
    await mkdir(folder);

    expect(await findMissingAnchorPaths([file, folder, missing])).toEqual([missing]);
  });

  it('hashes only the first bytes of a file over the cap and says so', async () => {
    const large = join(directory, 'large.bin');
    await writeFile(large, Buffer.alloc(MAX_HASHED_FILE_BYTES + 1));

    const [fingerprint] = await fingerprintAnchorPaths([large]);

    expect(fingerprint.partial).toBe(true);
    expect(fingerprint.hash).toHaveLength(64);
  });

  it('reports a file whose content differs from the stored hash, and nothing else', async () => {
    const edited = join(directory, 'edited.txt');
    const unchanged = join(directory, 'unchanged.txt');
    const absentAtSave = join(directory, 'absent-at-save.txt');
    await writeFile(edited, 'hello, edited');
    await writeFile(unchanged, 'hello');
    await writeFile(absentAtSave, 'created later');

    const fingerprints = await fingerprintAnchorPaths([edited, unchanged, absentAtSave]);

    expect(changedPathsOf(fingerprints, [SHA256_OF_HELLO, SHA256_OF_HELLO, ''])).toEqual([edited]);
  });
});
