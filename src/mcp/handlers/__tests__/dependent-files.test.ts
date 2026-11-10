import { describe, expect, it, vi } from 'vitest';

import { CoreNodeType, type Neo4jNode } from '../../../core/config/schema.js';
import {
  CANDIDATE_IMPORTS_QUERY,
  FILES_MENTIONING_QUERY,
  findDependentFiles,
  loadNodeIds,
  NODE_IDS_IN_FILES_QUERY,
} from '../dependent-files.js';

const node = (coreType: CoreNodeType, name: string, filePath: string, parentClassName?: string): Neo4jNode => ({
  id: `proj_code:${coreType}:${name}`,
  labels: ['TypeScript'],
  properties: {
    id: `proj_code:${coreType}:${name}`,
    projectId: 'proj_code',
    name,
    coreType,
    filePath,
    parentClassName,
    startLine: 1,
    endLine: 1,
    sourceCode: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
});
const importRow = (filePath: string, moduleSpecifier: string, sourceCode: string) => ({
  filePath,
  moduleSpecifier,
  sourceCode,
});
const neo4jReturning = (rows: Array<ReturnType<typeof importRow>>) => ({ run: vi.fn(async () => rows) });

describe('findDependentFiles', () => {
  it('finds the files that import a new declaration by name', async () => {
    const neo4j = neo4jReturning([
      importRow('/work/code/src/caller.ts', './chunker.js', "import { chunkNote, other } from './chunker.js';"),
      importRow('/work/code/src/barrel-user.ts', './index.js', "import { chunkNote as chunk } from './index.js';"),
      importRow('/work/code/src/bystander.ts', './chunkNote.js', "import { unrelated } from './chunkNote.js';"),
    ]);

    const dependents = await findDependentFiles(
      neo4j as never,
      [node(CoreNodeType.FUNCTION_DECLARATION, 'chunkNote', '/work/code/src/chunker.ts')],
      ['/work/code/src/chunker.ts'],
      'proj_code',
    );

    expect(neo4j.run).toHaveBeenCalledWith(CANDIDATE_IMPORTS_QUERY, {
      projectId: 'proj_code',
      importType: 'ImportDeclaration',
      excludeFilePaths: ['/work/code/src/chunker.ts'],
      names: ['chunkNote'],
      moduleNames: [],
    });
    expect(dependents).toEqual(['/work/code/src/caller.ts', '/work/code/src/barrel-user.ts']);
  });

  it('keeps the importers of a class that mention its new member', async () => {
    const run = vi.fn(async (query: string) =>
      query === CANDIDATE_IMPORTS_QUERY
        ? [
            importRow('/work/code/src/caller.ts', './service.js', "import { Service } from './service.js';"),
            importRow('/work/code/src/holder.ts', './service.js', "import type { Service } from './service.js';"),
          ]
        : [{ filePath: '/work/code/src/caller.ts' }],
    );

    const dependents = await findDependentFiles(
      { run } as never,
      [node(CoreNodeType.METHOD_DECLARATION, 'refresh', '/work/code/src/service.ts', 'Service')],
      ['/work/code/src/service.ts'],
      'proj_code',
    );

    expect(run).toHaveBeenCalledWith(CANDIDATE_IMPORTS_QUERY, expect.objectContaining({ names: ['Service'] }));
    expect(run).toHaveBeenCalledWith(FILES_MENTIONING_QUERY, {
      projectId: 'proj_code',
      filePaths: ['/work/code/src/caller.ts', '/work/code/src/holder.ts'],
      names: ['refresh'],
    });
    expect(dependents).toEqual(['/work/code/src/caller.ts']);
  });

  it('keeps every importer of a class that gained a constructor', async () => {
    const neo4j = neo4jReturning([
      importRow('/work/code/src/factory.ts', './service.js', "import { Service } from './service.js';"),
    ]);

    const dependents = await findDependentFiles(
      neo4j as never,
      [node(CoreNodeType.CONSTRUCTOR_DECLARATION, 'constructor', '/work/code/src/service.ts', 'Service')],
      ['/work/code/src/service.ts'],
      'proj_code',
    );

    expect(neo4j.run).toHaveBeenCalledTimes(1);
    expect(dependents).toEqual(['/work/code/src/factory.ts']);
  });

  it('finds the files whose import specifier resolves to a new file, whatever they import from it', async () => {
    const neo4j = neo4jReturning([
      importRow(
        '/work/code/src/cli/cli.ts',
        '../utils/data-directory.js',
        "import * as data from '../utils/data-directory.js';",
      ),
      importRow('/work/code/src/cli/setup.ts', '../utils/data-directory', "import '../utils/data-directory';"),
      importRow(
        '/work/code/src/app.ts',
        '@code/utils/data-directory',
        "import data from '@code/utils/data-directory';",
      ),
      importRow(
        '/work/code/src/other/local.ts',
        './data-directory.js',
        "import * as local from './data-directory.js';",
      ),
    ]);

    const dependents = await findDependentFiles(
      neo4j as never,
      [node(CoreNodeType.SOURCE_FILE, 'data-directory.ts', '/work/code/src/utils/data-directory.ts')],
      ['/work/code/src/utils/data-directory.ts'],
      'proj_code',
    );

    expect(neo4j.run).toHaveBeenCalledWith(
      CANDIDATE_IMPORTS_QUERY,
      expect.objectContaining({ names: [], moduleNames: ['data-directory'] }),
    );
    expect(dependents).toEqual(['/work/code/src/cli/cli.ts', '/work/code/src/cli/setup.ts', '/work/code/src/app.ts']);
  });

  it('treats a new index file as its directory', async () => {
    const neo4j = neo4jReturning([
      importRow('/work/code/src/app.ts', './projects', "import * as projects from './projects';"),
      importRow(
        '/work/code/src/tools/list.ts',
        '../projects/index.js',
        "import * as projects from '../projects/index.js';",
      ),
      importRow('/work/code/src/tools/other.ts', './index.js', "import * as tools from './index.js';"),
    ]);

    const dependents = await findDependentFiles(
      neo4j as never,
      [node(CoreNodeType.SOURCE_FILE, 'index.ts', '/work/code/src/projects/index.ts')],
      ['/work/code/src/projects/index.ts'],
      'proj_code',
    );

    expect(neo4j.run).toHaveBeenCalledWith(
      CANDIDATE_IMPORTS_QUERY,
      expect.objectContaining({ moduleNames: ['index', 'projects'] }),
    );
    expect(dependents).toEqual(['/work/code/src/app.ts', '/work/code/src/tools/list.ts']);
  });

  it('reads nothing from the graph when the reparse added only nodes an import cannot name', async () => {
    const neo4j = neo4jReturning([]);

    const dependents = await findDependentFiles(
      neo4j as never,
      [
        node(CoreNodeType.IMPORT_DECLARATION, 'path', '/work/code/src/caller.ts'),
        node(CoreNodeType.PARAMETER_DECLARATION, 'path', '/work/code/src/caller.ts'),
      ],
      ['/work/code/src/caller.ts'],
      'proj_code',
    );

    expect(dependents).toEqual([]);
    expect(neo4j.run).not.toHaveBeenCalled();
  });
});

describe('loadNodeIds', () => {
  it('returns the ids the given files have in the graph', async () => {
    const run = vi.fn(async () => [{ id: 'proj_code:FunctionDeclaration:one' }, { id: 'proj_code:SourceFile:file' }]);

    const ids = await loadNodeIds({ run } as never, ['/work/code/src/one.ts'], 'proj_code');

    expect(run).toHaveBeenCalledWith(NODE_IDS_IN_FILES_QUERY, {
      filePaths: ['/work/code/src/one.ts'],
      projectId: 'proj_code',
    });
    expect(ids).toEqual(new Set(['proj_code:FunctionDeclaration:one', 'proj_code:SourceFile:file']));
  });
});
