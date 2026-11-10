import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QUERIES } from '../../../storage/neo4j/neo4j.service.js';
import { detectChangedFiles } from '../file-change-detection.js';

describe('detectChangedFiles', () => {
  let root: string;
  const pathOf = (name: string) => join(root, 'src', name);
  const indexedAsOnDisk = (name: string) => ({
    filePath: pathOf(name),
    mtime: statSync(pathOf(name)).mtimeMs,
    size: statSync(pathOf(name)).size,
    contentHash: createHash('sha256')
      .update(readFileSync(pathOf(name)))
      .digest('hex'),
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'change-detection-')));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"name": "lab"}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    for (const name of ['same.ts', 'edited.ts', 'added.ts', 'added.test.ts']) {
      writeFileSync(pathOf(name), `export const value = '${name}';\n`);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('compares disk with the files the TypeScript parser indexed, which leaves config-file nodes out', () => {
    expect(QUERIES.GET_SOURCE_FILE_TRACKING_INFO).toContain('MATCH (sf:SourceFile:TypeScript)');
  });

  it('reports edited and new source files to reparse and indexed files missing from disk to delete', async () => {
    const run = vi.fn(async () => [
      indexedAsOnDisk('same.ts'),
      { ...indexedAsOnDisk('edited.ts'), contentHash: 'hash-before-the-edit' },
      { filePath: pathOf('removed.ts'), mtime: 1, size: 1, contentHash: 'removed' },
    ]);

    const changes = await detectChangedFiles(root, { run } as never, 'proj_lab');

    expect(run).toHaveBeenCalledWith(QUERIES.GET_SOURCE_FILE_TRACKING_INFO, { projectId: 'proj_lab' });
    expect(changes.filesToReparse.sort()).toEqual([pathOf('added.ts'), pathOf('edited.ts')]);
    expect(changes.filesToDelete).toEqual([pathOf('removed.ts')]);
  });
});
