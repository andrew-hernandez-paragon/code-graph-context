import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectStore } from '../../../core/projects/__tests__/project-store.fake.js';
import { createCreateProjectTool } from '../create-project.tool.js';
import { createListProjectsTool } from '../list-projects.tool.js';

const { storeRef } = vi.hoisted(() => ({ storeRef: { run: undefined as unknown as (...args: unknown[]) => unknown } }));
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

const handlerOf = (createTool: (server: McpServer) => void) => {
  const registerTool = vi.fn();
  createTool({ registerTool } as unknown as McpServer);
  return registerTool.mock.calls[0][2] as (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};
const textOf = (response: { content: Array<{ text: string }> }) => response.content[0].text;

describe('create_project', () => {
  beforeEach(() => {
    storeRef.run = createProjectStore([
      { projectId: 'proj_aaaaaaaaaaaa', name: 'agent-os', kind: 'codebase', path: '/work/agent-os' },
    ]).run;
  });

  it('creates a collection and reports created true', async () => {
    const response = await handlerOf(createCreateProjectTool)({
      kind: 'collection',
      name: 'on-call',
      description: 'runbooks',
    });

    expect(JSON.parse(textOf(response))).toMatchObject({
      created: true,
      project: { projectId: 'proj_on-call', kind: 'collection', description: 'runbooks' },
    });
  });

  it('returns the existing collection with created false on a second call', async () => {
    const handler = handlerOf(createCreateProjectTool);
    await handler({ kind: 'collection', name: 'on-call', description: 'runbooks' });

    const second = JSON.parse(textOf(await handler({ kind: 'collection', name: 'on-call', description: 'runbooks' })));

    expect(second.created).toBe(false);
    expect(second.project.projectId).toBe('proj_on-call');
  });

  it('reports a kind conflict as an error', async () => {
    const response = await handlerOf(createCreateProjectTool)({
      kind: 'collection',
      name: 'agent-os',
      description: 'notes',
    });

    expect(textOf(response)).toMatch(/A project named 'agent-os' already exists/);
  });

  it('asks for a path when kind is directory and none is given', async () => {
    const response = await handlerOf(createCreateProjectTool)({ kind: 'directory' });

    expect(textOf(response)).toMatch(/needs a path to an existing directory/);
  });

  it('asks for a name when kind is collection and none is given', async () => {
    const response = await handlerOf(createCreateProjectTool)({ kind: 'collection', description: 'x' });

    expect(textOf(response)).toMatch(/needs a name/);
  });
});

describe('list_projects', () => {
  beforeEach(() => {
    storeRef.run = createProjectStore([
      {
        projectId: 'proj_aaaaaaaaaaaa',
        name: 'agent-os',
        kind: 'codebase',
        path: '/work/agent-os',
        status: 'complete',
        embeddingModel: 'BAAI/bge-base-en-v1.5',
        embeddingDimensions: 768,
      },
      { projectId: 'proj_on-call', name: 'on-call', kind: 'collection', description: 'runbooks' },
    ]).run;
  });

  it('lists every kind with memory counts as JSON', async () => {
    const { projects } = JSON.parse(textOf(await handlerOf(createListProjectsTool)({})));

    expect(projects.map((p: { projectId: string }) => p.projectId)).toEqual(['proj_aaaaaaaaaaaa', 'proj_on-call']);
    expect(projects[1]).toMatchObject({
      name: 'on-call',
      kind: 'collection',
      path: null,
      description: 'runbooks',
      memory: { liveNotes: 2, bookmarks: 1, lastSavedAt: '2023-11-14T22:21:40.000Z' },
    });
  });

  it('shows the embedding model and dimensions of a codebase, and null for a project without a stamp', async () => {
    const { projects } = JSON.parse(textOf(await handlerOf(createListProjectsTool)({})));

    expect(projects[0]).toMatchObject({ embeddingModel: 'BAAI/bge-base-en-v1.5', embeddingDimensions: 768 });
    expect(projects[1]).toMatchObject({ embeddingModel: null, embeddingDimensions: null });
  });

  it('filters by kind', async () => {
    const { projects } = JSON.parse(textOf(await handlerOf(createListProjectsTool)({ kinds: ['codebase'] })));

    expect(projects.map((p: { projectId: string }) => p.projectId)).toEqual(['proj_aaaaaaaaaaaa']);
  });

  it('says how to add a project when none match', async () => {
    const response = JSON.parse(textOf(await handlerOf(createListProjectsTool)({ kinds: ['directory'] })));

    expect(response).toEqual({
      status: 'empty',
      message: 'No projects of kind directory found',
      suggestion:
        'Call create_project to add a directory or collection of memories, or parse_typescript_project to add a codebase.',
    });
  });
});
