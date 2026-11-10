import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';

import { Neo4jEdge, Neo4jNode } from '../../config/schema.js';
import { ParserFactory, ProjectType } from '../parser-factory.js';
import { TypeScriptParser } from '../typescript-parser.js';

export const FIXTURE_PROJECT_ID = 'proj_fixture';

export interface ParsedGraph {
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
}

/** A TypeScript project on disk, written from a map of relative path to source. */
export class ParserFixture {
  private constructor(readonly root: string) {}

  static async create(files: Record<string, string>): Promise<ParserFixture> {
    // realpath: the parser reports the paths TypeScript resolved, and the OS temp directory is a symlink on macOS.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'parser-fixture-')));
    const tsconfig = {
      compilerOptions: { module: 'ESNext', target: 'ES2022', moduleResolution: 'node', strict: true },
    };
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    return new ParserFixture(root);
  }

  path(relativePath: string): string {
    return join(this.root, relativePath);
  }

  createParser(): TypeScriptParser {
    return ParserFactory.createParser({
      workspacePath: this.root,
      tsConfigPath: this.path('tsconfig.json'),
      projectType: ProjectType.VANILLA,
      projectId: FIXTURE_PROJECT_ID,
      lazyLoad: true,
    });
  }

  /** Every edge of one type as "start -> end", sorted, with each end named by `describeNode`. */
  describeEdges(graph: ParsedGraph, type: string, describeNode: (node: Neo4jNode) => string): string[] {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const describe = (id: string) => {
      const node = nodesById.get(id);
      return node ? describeNode(node) : `missing node ${id}`;
    };
    return graph.edges
      .filter((edge) => edge.type === type)
      .map((edge) => `${describe(edge.startNodeId)} -> ${describe(edge.endNodeId)}`)
      .sort();
  }

  relativePath(node: Neo4jNode): string {
    return relative(this.root, node.properties.filePath);
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
