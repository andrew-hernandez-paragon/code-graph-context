import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ParsedGraph, ParserFixture } from './parser-fixture.js';

const FILES = {
  'src/models/widget.ts': `export class Widget {}\nexport const WIDGET_LIMIT = 3;\n`,
  'src/models/gadget.ts': `export class Gadget {}\n`,
  'src/models/index.ts': `export * from './widget';\nexport { Gadget } from './gadget';\n`,
  'src/index.ts': `export * from './models';\n`,
  'src/uses-star.ts': `import { Widget } from './models';\nexport const widget = new Widget();\n`,
  'src/uses-named.ts': `import { Gadget } from './models';\nexport const gadget = new Gadget();\n`,
  'src/uses-chain.ts': `import { Widget as Renamed } from './index';\nexport const widget = new Renamed();\n`,
  'src/uses-type.ts': `import type { Widget } from './models';\nexport type Widgets = Widget[];\n`,
  'src/tools/hammer.ts': `export const hit = (): string => 'bang';\n`,
  'src/tools/index.ts': `export * as tools from './hammer';\n`,
  'src/uses-namespace-export.ts': `import { tools } from './tools';\nexport const sound = tools.hit();\n`,
  'src/uses-namespace-import.ts': `import * as models from './models';\nexport const limit = models.WIDGET_LIMIT;\n`,
  'src/cycle/a.ts': `export * from './b';\nexport const fromA = 1;\n`,
  'src/cycle/b.ts': `export * from './a';\nexport const fromB = 2;\n`,
  'src/uses-cycle.ts': `import { fromA, fromB } from './cycle/a';\nexport const sum = fromA + fromB;\n`,
};

describe('IMPORTS edges through re-exports', () => {
  let fixture: ParserFixture;
  let graph: ParsedGraph;
  const importEdges = () => fixture.describeEdges(graph, 'IMPORTS', (node) => fixture.relativePath(node));
  const importersOf = (file: string) =>
    importEdges()
      .filter((edge) => edge.endsWith(` -> ${file}`))
      .map((edge) => edge.split(' -> ')[0]);

  beforeAll(async () => {
    fixture = await ParserFixture.create(FILES);
    graph = await fixture.createParser().parseWorkspace();
  });
  afterAll(async () => {
    await fixture.remove();
  });

  it('links a barrel to each module it re-exports from, for export *, named and namespace re-exports', () => {
    expect(importEdges().filter((edge) => edge.includes('index.ts -> '))).toEqual([
      'src/index.ts -> src/models/index.ts',
      'src/models/index.ts -> src/models/gadget.ts',
      'src/models/index.ts -> src/models/widget.ts',
      'src/tools/index.ts -> src/tools/hammer.ts',
    ]);
  });

  it('counts a file that imports a class through export * as a dependent of the file that defines it', () => {
    expect(importersOf('src/models/widget.ts')).toEqual([
      'src/models/index.ts',
      'src/uses-chain.ts',
      'src/uses-namespace-import.ts',
      'src/uses-star.ts',
      'src/uses-type.ts',
    ]);
  });

  it('links a named re-export only to the file that defines the imported name', () => {
    expect(importEdges().filter((edge) => edge.startsWith('src/uses-named.ts'))).toEqual([
      'src/uses-named.ts -> src/models/gadget.ts',
      'src/uses-named.ts -> src/models/index.ts',
    ]);
  });

  it('follows a two-level barrel chain to the defining file', () => {
    expect(importEdges().filter((edge) => edge.startsWith('src/uses-chain.ts'))).toEqual([
      'src/uses-chain.ts -> src/index.ts',
      'src/uses-chain.ts -> src/models/widget.ts',
    ]);
  });

  it('follows export * as ns to the module behind the namespace', () => {
    expect(importEdges().filter((edge) => edge.startsWith('src/uses-namespace-export.ts'))).toEqual([
      'src/uses-namespace-export.ts -> src/tools/hammer.ts',
      'src/uses-namespace-export.ts -> src/tools/index.ts',
    ]);
  });

  it('links a namespace import of a barrel to every file the barrel exposes', () => {
    expect(importEdges().filter((edge) => edge.startsWith('src/uses-namespace-import.ts'))).toEqual([
      'src/uses-namespace-import.ts -> src/models/gadget.ts',
      'src/uses-namespace-import.ts -> src/models/index.ts',
      'src/uses-namespace-import.ts -> src/models/widget.ts',
    ]);
  });

  it('terminates on a cycle between two barrels and links each name to its own file', () => {
    expect(importEdges().filter((edge) => edge.includes('cycle'))).toEqual([
      'src/cycle/a.ts -> src/cycle/b.ts',
      'src/cycle/b.ts -> src/cycle/a.ts',
      'src/uses-cycle.ts -> src/cycle/a.ts',
      'src/uses-cycle.ts -> src/cycle/b.ts',
    ]);
  });
});

describe('IMPORTS edges across chunks', () => {
  let fixture: ParserFixture;

  beforeAll(async () => {
    fixture = await ParserFixture.create(FILES);
  });
  afterAll(async () => {
    await fixture.remove();
  });

  it('resolves a barrel import whose defining file was parsed in an earlier chunk', async () => {
    const parser = fixture.createParser();
    const first = await parser.parseChunk(
      ['src/models/widget.ts', 'src/models/gadget.ts', 'src/models/index.ts'].map((file) => fixture.path(file)),
      true,
    );
    parser.addExistingNodesFromChunk(first.nodes);
    const second = await parser.parseChunk([fixture.path('src/uses-star.ts')], true);
    parser.addExistingNodesFromChunk(second.nodes);
    const edges = await parser.resolveDeferredEdges();

    const graph = { nodes: [...first.nodes, ...second.nodes], edges };
    expect(fixture.describeEdges(graph, 'IMPORTS', (node) => fixture.relativePath(node))).toEqual([
      'src/models/index.ts -> src/models/gadget.ts',
      'src/models/index.ts -> src/models/widget.ts',
      'src/uses-star.ts -> src/models/index.ts',
      'src/uses-star.ts -> src/models/widget.ts',
    ]);
  });

  it('resolves edges a chunk worker deferred once the coordinator holds every node', async () => {
    const worker = fixture.createParser();
    const chunk = await worker.parseChunk(
      ['src/models/widget.ts', 'src/models/index.ts', 'src/uses-star.ts'].map((file) => fixture.path(file)),
      true,
    );
    const coordinator = fixture.createParser();
    coordinator.addParsedNodesFromChunk(chunk.nodes);
    coordinator.mergeDeferredEdges(worker.getDeferredEdges());
    const edges = await coordinator.resolveDeferredEdges();

    expect(
      fixture.describeEdges({ nodes: chunk.nodes, edges }, 'IMPORTS', (node) => fixture.relativePath(node)),
    ).toEqual([
      'src/models/index.ts -> src/models/widget.ts',
      'src/uses-star.ts -> src/models/index.ts',
      'src/uses-star.ts -> src/models/widget.ts',
    ]);
  });
});
