import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Neo4jNode } from '../../config/schema.js';
import { WorkspaceConfig } from '../../workspace/index.js';
import { ProjectType } from '../parser-factory.js';
import { ExistingNode } from '../typescript-parser.js';
import { WorkspaceParser } from '../workspace-parser.js';

import { FIXTURE_PROJECT_ID, ParsedGraph, ParserFixture } from './parser-fixture.js';

const FILES = {
  'src/runner.ts': `
export interface Runner {
  run(command: string): string;
}
export interface LoggingRunner extends Runner {
  lastCommand(): string;
}
export class ProcessRunner implements Runner {
  run(command: string): string {
    return command.trim();
  }
}
export class RecordingRunner implements LoggingRunner {
  private last = '';
  run(command: string): string {
    this.last = command;
    return command;
  }
  lastCommand(): string {
    return this.last.trim();
  }
}
`,
  'src/store.ts': `
export class Store {
  constructor(private readonly prefix: string) {}
  run(query: string): string {
    return this.prefix + query.toUpperCase();
  }
  now(): number {
    return this.prefix.length + 1;
  }
}
`,
  'src/base.ts': `
export class BaseJob {
  describe(): string {
    return 'a job that can be described';
  }
}
`,
  'src/format.ts': `
export function format(value: string): string {
  return '[' + value + ']';
}
`,
  'src/other/format.ts': `
export function format(value: number): number {
  return value * 2 + 1;
}
`,
  'src/other/store.ts': `
export class Store {
  run(query: string): string {
    return 'other ' + query;
  }
}
`,
  'src/app.ts': `
import { BaseJob } from './base';
import { format as render } from './format';
import { LoggingRunner, Runner } from './runner';
import { Store } from './store';

export class App extends BaseJob {
  constructor(
    private readonly runner: Runner,
    private readonly recorder: LoggingRunner,
    private readonly store: Store,
  ) {
    super();
  }
  viaInterface(): string {
    return this.runner.run('ls -la /tmp');
  }
  viaSubInterface(): string {
    return this.recorder.run('ls -la /tmp') + this.recorder.lastCommand();
  }
  viaClass(): string {
    return this.store.run('select 1 from dual');
  }
  viaUnknown(job: any): string {
    return job.run('the type of job is unknown');
  }
  viaOtherType(): number {
    return Date.now() + performance.now();
  }
  viaLocal(): string {
    const local = new Store('a local variable ');
    return local.run('from a local variable');
  }
  viaInheritance(): string {
    return this.describe() + this.viaClass();
  }
  viaImportedFunction(): string {
    return render('an imported function');
  }
}
`,
};

const describeCallable = (fixture: ParserFixture) => (node: Neo4jNode) => {
  const owner = node.properties.parentClassName ? `${node.properties.parentClassName}.` : '';
  return `${fixture.relativePath(node)}#${owner}${node.properties.name}`;
};

const EXPECTED_CALLS = [
  'src/app.ts#App.viaClass -> src/store.ts#Store.run',
  'src/app.ts#App.viaImportedFunction -> src/format.ts#format',
  'src/app.ts#App.viaInheritance -> src/app.ts#App.viaClass',
  'src/app.ts#App.viaInheritance -> src/base.ts#BaseJob.describe',
  'src/app.ts#App.viaInterface -> src/runner.ts#ProcessRunner.run',
  'src/app.ts#App.viaInterface -> src/runner.ts#RecordingRunner.run',
  'src/app.ts#App.viaLocal -> src/store.ts#Store.constructor',
  'src/app.ts#App.viaLocal -> src/store.ts#Store.run',
  'src/app.ts#App.viaSubInterface -> src/runner.ts#RecordingRunner.lastCommand',
  'src/app.ts#App.viaSubInterface -> src/runner.ts#RecordingRunner.run',
];

describe('CALLS edges', () => {
  let fixture: ParserFixture;
  let graph: ParsedGraph;
  const callEdges = () => fixture.describeEdges(graph, 'CALLS', describeCallable(fixture));
  const callersOf = (callee: string) =>
    callEdges()
      .filter((edge) => edge.endsWith(` -> ${callee}`))
      .map((edge) => edge.split(' -> ')[0]);

  beforeAll(async () => {
    fixture = await ParserFixture.create(FILES);
    graph = await fixture.createParser().parseWorkspace();
  });
  afterAll(async () => {
    await fixture.remove();
  });

  it('links each call to the declaration the type checker resolves it to, and to nothing else', () => {
    expect(callEdges()).toEqual(EXPECTED_CALLS);
  });

  it('links a call on a class-typed receiver only to that class, not to a same-named method elsewhere', () => {
    expect(callersOf('src/store.ts#Store.run')).toEqual(['src/app.ts#App.viaClass', 'src/app.ts#App.viaLocal']);
    expect(callersOf('src/other/store.ts#Store.run')).toEqual([]);
  });

  it('links a call through an interface to every class that implements it, directly or through a sub-interface', () => {
    expect(callEdges().filter((edge) => edge.startsWith('src/app.ts#App.viaInterface'))).toEqual([
      'src/app.ts#App.viaInterface -> src/runner.ts#ProcessRunner.run',
      'src/app.ts#App.viaInterface -> src/runner.ts#RecordingRunner.run',
    ]);
  });

  it('links a call through a sub-interface only to the classes that implement the sub-interface', () => {
    expect(callEdges().filter((edge) => edge.startsWith('src/app.ts#App.viaSubInterface'))).toEqual([
      'src/app.ts#App.viaSubInterface -> src/runner.ts#RecordingRunner.lastCommand',
      'src/app.ts#App.viaSubInterface -> src/runner.ts#RecordingRunner.run',
    ]);
  });

  it('creates no edge when the receiver type is unknown or is a type from outside the project', () => {
    expect(callEdges().filter((edge) => edge.startsWith('src/app.ts#App.viaUnknown'))).toEqual([]);
    expect(callersOf('src/store.ts#Store.now')).toEqual([]);
  });

  it('links an imported function to the file it was imported from, not to a same-named function', () => {
    expect(callersOf('src/format.ts#format')).toEqual(['src/app.ts#App.viaImportedFunction']);
    expect(callersOf('src/other/format.ts#format')).toEqual([]);
  });
});

describe('CALLS edges resolved after the calling file was parsed', () => {
  let fixture: ParserFixture;
  const allFiles = () => Object.keys(FILES).map((file) => fixture.path(file));
  const callEdges = (graph: ParsedGraph) => fixture.describeEdges(graph, 'CALLS', describeCallable(fixture));

  beforeAll(async () => {
    fixture = await ParserFixture.create(FILES);
  });
  afterAll(async () => {
    await fixture.remove();
  });

  it('resolves calls into a later chunk once every chunk is parsed', async () => {
    const parser = fixture.createParser();
    const first = await parser.parseChunk([fixture.path('src/app.ts')], true);
    parser.addExistingNodesFromChunk(first.nodes);
    const second = await parser.parseChunk(
      allFiles().filter((file) => file !== fixture.path('src/app.ts')),
      true,
    );
    parser.addExistingNodesFromChunk(second.nodes);
    const edges = await parser.resolveDeferredEdges();

    expect(callEdges({ nodes: [...first.nodes, ...second.nodes], edges })).toEqual(EXPECTED_CALLS);
  });

  it('resolves the calls a chunk worker deferred in a single-package coordinator', async () => {
    const worker = fixture.createParser();
    const chunk = await worker.parseChunk(allFiles(), true);
    const coordinator = fixture.createParser();
    coordinator.addParsedNodesFromChunk(chunk.nodes);
    coordinator.mergeDeferredEdges(worker.getDeferredEdges());
    const edges = await coordinator.resolveDeferredEdges();

    expect(callEdges({ nodes: chunk.nodes, edges })).toEqual(EXPECTED_CALLS);
  });

  it('resolves the calls a chunk worker deferred in a workspace coordinator', async () => {
    const worker = fixture.createParser();
    const chunk = await worker.parseChunk(allFiles(), true);
    const workspace: WorkspaceConfig = { type: 'npm', rootPath: fixture.root, packages: [] };
    const coordinator = new WorkspaceParser(workspace, FIXTURE_PROJECT_ID, true, ProjectType.VANILLA);
    coordinator.addParsedNodesFromChunk(chunk.nodes);
    coordinator.mergeDeferredEdges(worker.getDeferredEdges());
    const edges = await coordinator.resolveDeferredEdges();

    expect(callEdges({ nodes: chunk.nodes, edges })).toEqual(EXPECTED_CALLS);
  });

  it('links a re-parsed file to methods in files that were not re-parsed', async () => {
    const full = await fixture.createParser().parseWorkspace();
    const unchanged: ExistingNode[] = full.nodes
      .filter((node) => node.properties.filePath !== fixture.path('src/app.ts'))
      .map((node) => ({
        id: node.id,
        name: node.properties.name,
        coreType: node.properties.coreType,
        labels: node.labels,
        filePath: node.properties.filePath,
      }));
    const parser = fixture.createParser();
    parser.setExistingNodes(unchanged);
    const reparsed = await parser.parseWorkspace([fixture.path('src/app.ts')]);

    const describe = describeCallable(fixture);
    const nodesById = new Map(full.nodes.map((node) => [node.id, node]));
    const calls = reparsed.edges
      .filter((edge) => edge.type === 'CALLS')
      .map((edge) => [edge.startNodeId, edge.endNodeId].map((id) => nodesById.get(id)))
      .map(([caller, callee]) => (caller && callee ? `${describe(caller)} -> ${describe(callee)}` : 'missing node'))
      .sort();
    // The classes that implement Runner were not re-parsed, so their IMPLEMENTS edges are not in this parse.
    expect(calls).toEqual([
      'src/app.ts#App.viaClass -> src/store.ts#Store.run',
      'src/app.ts#App.viaImportedFunction -> src/format.ts#format',
      'src/app.ts#App.viaInheritance -> src/app.ts#App.viaClass',
      'src/app.ts#App.viaInheritance -> src/base.ts#BaseJob.describe',
      'src/app.ts#App.viaLocal -> src/store.ts#Store.constructor',
      'src/app.ts#App.viaLocal -> src/store.ts#Store.run',
    ]);
  });
});
