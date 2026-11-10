import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Neo4jNode } from '../../config/schema.js';
import { WorkspaceDetector, detectWorkspaceSourcePaths } from '../../workspace/index.js';
import { ParserFactory, ProjectType } from '../parser-factory.js';
import { WorkspaceParser } from '../workspace-parser.js';

import { FIXTURE_PROJECT_ID, ParsedGraph, ParserFixture } from './parser-fixture.js';

const packageTsconfig = (outDir: string, rootDir: string) =>
  JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { outDir, rootDir } });

const FILES = {
  'package.json': JSON.stringify({ name: 'fixture-workspace', private: true, workspaces: ['packages/*'] }),

  'packages/shared/package.json': JSON.stringify({
    name: '@fixture/shared',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './ports': { types: './dist/ports/index.d.ts', default: './dist/ports/index.js' },
    },
  }),
  'packages/shared/tsconfig.json': packageTsconfig('./dist', './src'),
  'packages/shared/src/index.ts': `export * from './greeter';\nexport { format } from './format';\n`,
  'packages/shared/src/greeter.ts': `
export class Greeter {
  constructor(private readonly name: string) {}
  greet(): string {
    return 'hello ' + this.name;
  }
}
`,
  'packages/shared/src/format.ts': `
export function format(value: string): string {
  return '[' + value + ']';
}
`,
  'packages/shared/src/ports/index.ts': `
export interface Clock {
  now(): number;
}
`,

  // No source field, and neither dist nor src: the entry is found through the package's outDir and rootDir.
  'packages/tools/package.json': JSON.stringify({ name: '@fixture/tools', main: 'lib/main.js' }),
  'packages/tools/tsconfig.json': packageTsconfig('./lib', './source'),
  'packages/tools/source/main.ts': `
export function sharpen(value: string): string {
  return value.toUpperCase() + '!';
}
`,

  'packages/app/package.json': JSON.stringify({ name: '@fixture/app', dependencies: { '@fixture/shared': '*' } }),
  'packages/app/tsconfig.json': packageTsconfig('./dist', './src'),
  'packages/app/src/system-clock.ts': `
import { Clock } from '@fixture/shared/ports';

export class SystemClock implements Clock {
  now(): number {
    return Date.now() + 0;
  }
}
`,
  'packages/app/src/app.ts': `
import { Greeter, format } from '@fixture/shared';
import type { Clock } from '@fixture/shared/ports';
import { sharpen } from '@fixture/tools';

export class App {
  constructor(private readonly clock: Clock) {}
  run(): string {
    const greeter = new Greeter('workspace');
    return format(greeter.greet()) + sharpen('edge') + this.clock.now();
  }
}
`,
};

const EXPECTED_IMPORTS = [
  'packages/app/src/app.ts -> packages/shared/src/format.ts',
  'packages/app/src/app.ts -> packages/shared/src/greeter.ts',
  'packages/app/src/app.ts -> packages/shared/src/index.ts',
  'packages/app/src/app.ts -> packages/shared/src/ports/index.ts',
  'packages/app/src/app.ts -> packages/tools/source/main.ts',
  'packages/app/src/system-clock.ts -> packages/shared/src/ports/index.ts',
  'packages/shared/src/index.ts -> packages/shared/src/format.ts',
  'packages/shared/src/index.ts -> packages/shared/src/greeter.ts',
];

const EXPECTED_CALLS = [
  'packages/app/src/app.ts#App.run -> packages/app/src/system-clock.ts#SystemClock.now',
  'packages/app/src/app.ts#App.run -> packages/shared/src/format.ts#format',
  'packages/app/src/app.ts#App.run -> packages/shared/src/greeter.ts#Greeter.constructor',
  'packages/app/src/app.ts#App.run -> packages/shared/src/greeter.ts#Greeter.greet',
  'packages/app/src/app.ts#App.run -> packages/tools/source/main.ts#sharpen',
];

describe('edges between workspace packages', () => {
  let fixture: ParserFixture;
  const describeCallable = (node: Neo4jNode) => {
    const owner = node.properties.parentClassName ? `${node.properties.parentClassName}.` : '';
    return `${fixture.relativePath(node)}#${owner}${node.properties.name}`;
  };
  const importEdges = (graph: ParsedGraph) =>
    fixture.describeEdges(graph, 'IMPORTS', (node) => fixture.relativePath(node));
  const callEdges = (graph: ParsedGraph) => fixture.describeEdges(graph, 'CALLS', describeCallable);
  const workspaceParser = async () =>
    new WorkspaceParser(
      await new WorkspaceDetector().detect(fixture.root),
      FIXTURE_PROJECT_ID,
      true,
      ProjectType.VANILLA,
    );

  beforeAll(async () => {
    fixture = await ParserFixture.create(FILES);
  });
  afterAll(async () => {
    await fixture.remove();
  });

  it('maps each package name and exported subpath to its source entry, with no build output on disk', async () => {
    expect(await detectWorkspaceSourcePaths(fixture.root)).toEqual({
      '@fixture/shared': [fixture.path('packages/shared/src/index.ts')],
      '@fixture/shared/ports': [fixture.path('packages/shared/src/ports/index.ts')],
      '@fixture/tools': [fixture.path('packages/tools/source/main.ts')],
    });
  });

  it('gives a project that is not a workspace no source paths', async () => {
    expect(await detectWorkspaceSourcePaths(fixture.path('packages/shared'))).toEqual({});
  });

  it('links imports and calls across packages in a workspace parse', async () => {
    const parser = await workspaceParser();
    const chunk = await parser.parseChunk(await parser.discoverSourceFiles(), true);
    parser.addExistingNodesFromChunk(chunk.nodes);
    const graph = { nodes: chunk.nodes, edges: await parser.resolveDeferredEdges() };

    expect(importEdges(graph)).toEqual(EXPECTED_IMPORTS);
    expect(callEdges(graph)).toEqual(EXPECTED_CALLS);
  });

  it('links them when the calling package is parsed before the packages it uses', async () => {
    const parser = await workspaceParser();
    const first = await parser.parseChunk([fixture.path('packages/app/src/app.ts')], true);
    parser.addExistingNodesFromChunk(first.nodes);
    const files = await parser.discoverSourceFiles();
    const second = await parser.parseChunk(
      files.filter((file) => file !== fixture.path('packages/app/src/app.ts')),
      true,
    );
    parser.addExistingNodesFromChunk(second.nodes);
    const graph = { nodes: [...first.nodes, ...second.nodes], edges: await parser.resolveDeferredEdges() };

    expect(importEdges(graph)).toEqual(EXPECTED_IMPORTS);
    expect(callEdges(graph)).toEqual(EXPECTED_CALLS);
  });

  it('links them when chunk workers parse from the workspace root and a workspace coordinator resolves', async () => {
    const worker = ParserFactory.createParser({
      workspacePath: fixture.root,
      tsConfigPath: fixture.path('tsconfig.json'),
      projectType: ProjectType.VANILLA,
      projectId: FIXTURE_PROJECT_ID,
      lazyLoad: true,
      workspaceSourcePaths: await detectWorkspaceSourcePaths(fixture.root),
    });
    const coordinator = await workspaceParser();
    const chunk = await worker.parseChunk(await coordinator.discoverSourceFiles(), true);
    coordinator.addParsedNodesFromChunk(chunk.nodes);
    coordinator.mergeDeferredEdges(worker.getDeferredEdges());
    const graph = { nodes: chunk.nodes, edges: await coordinator.resolveDeferredEdges() };

    expect(importEdges(graph)).toEqual(EXPECTED_IMPORTS);
    expect(callEdges(graph)).toEqual(EXPECTED_CALLS);
  });

  it('links them for a parser created at the workspace root with auto-detection, as the incremental parse does', async () => {
    const parser = await ParserFactory.createParserWithAutoDetection(
      fixture.root,
      fixture.path('tsconfig.json'),
      FIXTURE_PROJECT_ID,
      true,
    );
    const graph = await parser.parseWorkspace();

    expect(importEdges(graph)).toEqual(EXPECTED_IMPORTS);
    expect(callEdges(graph)).toEqual(EXPECTED_CALLS);
  });
});
