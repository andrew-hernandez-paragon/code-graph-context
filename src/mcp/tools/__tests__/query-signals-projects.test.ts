import { beforeEach, describe, expect, it, vi } from 'vitest';

const findProject = vi.hoisted(() => vi.fn());
const searchCodeRaw = vi.hoisted(() => vi.fn(async () => []));
const run = vi.hoisted(() => vi.fn(async (_query: string, _params?: Record<string, unknown>) => []));

vi.mock('../../../storage/neo4j/neo4j.service.js', () => ({
  Neo4jService: class {
    run = run;
    close = vi.fn(async () => undefined);
  },
}));
vi.mock('../../handlers/query-signals.handler.js', () => ({
  probeEmbeddingsHealth: vi.fn(async () => false),
  searchCodeRaw,
  projectCodeResult: vi.fn(),
}));
vi.mock('../../../core/projects/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/projects/index.js')>()),
  ProjectService: class {
    findProject = findProject;
  },
}));

import { createQuerySignalsTool } from '../query-signals.tool.js';

type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const captureHandler = (): Handler => {
  let handler: Handler | undefined;
  createQuerySignalsTool({
    registerTool: (_name: string, _config: unknown, callback: Handler) => {
      handler = callback;
    },
  } as never);
  if (!handler) throw new Error('query_signals was not registered');
  return handler;
};

describe('query_signals project resolution', () => {
  beforeEach(() => {
    findProject.mockReset();
    run.mockClear();
  });

  it('searches a project once when its id and its path resolve to the same project', async () => {
    findProject.mockResolvedValue({ projectId: 'proj_agentos' });

    const response = await captureHandler()({
      projectIds: ['agent-os', '/path/to/agent-os'],
      query: 'q',
      sources: ['pheromones'],
      limitPerSource: 3,
      groupBy: 'source',
      minSimilarity: 0.5,
      minIntensity: 0.3,
    });

    expect(response.isError).toBeUndefined();
    const searchedProjectIds = run.mock.calls.map(([, params]) => params?.projectIds);
    expect(searchedProjectIds.length).toBeGreaterThan(0);
    for (const ids of searchedProjectIds) expect(ids).toEqual(['proj_agentos']);
  });

  it('lists the inputs that did not resolve, and the resolver message that names the next call for each', async () => {
    findProject.mockImplementation(async (input: string) => {
      if (input === 'agent-os') return { projectId: 'proj_agentos' };
      throw new Error(`No project '${input}'. Call list_projects.`);
    });

    const response = await captureHandler()({
      projectIds: ['agent-os', 'typo'],
      query: 'q',
      sources: ['pheromones'],
      limitPerSource: 3,
      groupBy: 'source',
      minSimilarity: 0.5,
      minIntensity: 0.3,
    });

    const payload = JSON.parse(response.content[0].text);
    expect(payload.unresolvedProjectIds).toEqual(['typo']);
    expect(payload.unresolvedProjectErrors).toEqual(["No project 'typo'. Call list_projects."]);
  });
});
