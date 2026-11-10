import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectStore } from '../../../core/projects/__tests__/project-store.fake.js';
import { createStartWatchProjectTool } from '../start-watch-project.tool.js';

const { storeRef, startWatching } = vi.hoisted(() => ({
  storeRef: { run: undefined as unknown as (...args: unknown[]) => unknown },
  startWatching: vi.fn(),
}));
vi.mock('../../../storage/neo4j/neo4j.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../storage/neo4j/neo4j.service.js')>()),
  Neo4jService: class {
    run = (...args: unknown[]) => storeRef.run(...args);
    close = vi.fn();
  },
}));
vi.mock('../../utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils.js')>()),
  debugLog: vi.fn(),
}));
vi.mock('../../services/watch-manager.js', () => ({ watchManager: { startWatching } }));

const startWatchProject = () => {
  const registerTool = vi.fn();
  createStartWatchProjectTool({ registerTool } as unknown as McpServer);
  return registerTool.mock.calls[0][2] as (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

describe('start_watch_project', () => {
  let directory: string;
  let tsconfigPath: string;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'start-watch-')));
    tsconfigPath = join(directory, 'tsconfig.json');
    writeFileSync(tsconfigPath, '{}');
    startWatching.mockReset();
    startWatching.mockImplementation(async (config: { projectPath: string; projectId: string }) => ({
      projectPath: config.projectPath,
      projectId: config.projectId,
      status: 'active',
      debounceMs: 1000,
    }));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses a project id that is registered at another directory', async () => {
    storeRef.run = createProjectStore([
      { projectId: 'proj_aaaaaaaaaaaa', name: 'agent-os', kind: 'codebase', path: '/work/agent-os' },
    ]).run;

    const response = await startWatchProject()({
      projectPath: directory,
      tsconfigPath,
      projectId: 'proj_aaaaaaaaaaaa',
      debounceMs: 1000,
    });

    expect(response.content[0].text).toBe(
      `ERROR: Codebase 'agent-os' (proj_aaaaaaaaaaaa) is registered at /work/agent-os, not ${directory}. ` +
        `Parsing another directory under its id would replace every node id in its graph. ` +
        `Pass /work/agent-os as projectPath, or parse ${directory} as its own codebase.`,
    );
    expect(startWatching).not.toHaveBeenCalled();
  });

  it('starts the watcher when the project id is registered at the given directory', async () => {
    storeRef.run = createProjectStore([
      { projectId: 'proj_aaaaaaaaaaaa', name: 'agent-os', kind: 'codebase', path: directory },
    ]).run;

    await startWatchProject()({
      projectPath: directory,
      tsconfigPath,
      projectId: 'proj_aaaaaaaaaaaa',
      debounceMs: 1000,
    });

    expect(startWatching).toHaveBeenCalledWith({
      projectPath: directory,
      projectId: 'proj_aaaaaaaaaaaa',
      tsconfigPath,
      debounceMs: 1000,
    });
  });
});
