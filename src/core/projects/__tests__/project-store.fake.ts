import { vi } from 'vitest';

import type { ProjectKind } from '../project-kinds.js';
import {
  CREATE_PROJECT_QUERY,
  FIND_BY_DIRECTORY_NAME_QUERY,
  FIND_BY_ID_QUERY,
  FIND_BY_NAME_QUERY,
  FIND_BY_PATH_PREFIXES_QUERY,
  FIND_BY_ROOT_CANDIDATES_QUERY,
  FIND_EXISTING_IDS_QUERY,
  LIST_RECENT_QUERY,
  LIST_WITH_MEMORY_QUERY,
} from '../project.service.js';

export interface StoredProject {
  projectId: string;
  name: string;
  kind: ProjectKind;
  path?: string | null;
  description?: string | null;
  status?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
}

type Row = Record<string, any>;

/**
 * Stands in for Neo4j: answers each ProjectService statement from an in-memory list.
 * A statement is recognized by being the service's own exported query, so reformatting a query changes nothing here.
 */
export const createProjectStore = (initial: StoredProject[]) => {
  const projects = [...initial];
  const toRow = (project: StoredProject) => ({
    path: null,
    description: null,
    status: null,
    nodeCount: null,
    edgeCount: null,
    embeddingModel: null,
    embeddingDimensions: null,
    updatedAt: null,
    ...project,
  });

  const answers = new Map<string, (params: Row) => Row[]>([
    [
      LIST_WITH_MEMORY_QUERY,
      (params) =>
        projects
          .filter((project) => params.kinds.includes(project.kind))
          .map((project) => ({
            ...toRow(project),
            liveNotes: 2,
            bookmarks: 1,
            lastNoteAt: [1_700_000_000_000],
            lastBookmarkAt: [1_700_000_500_000],
          })),
    ],
    [
      CREATE_PROJECT_QUERY,
      (params) => {
        const created: StoredProject = {
          projectId: params.projectId,
          name: params.name,
          kind: params.kind,
          path: params.path,
          description: params.description,
        };
        projects.push(created);
        return [toRow(created)];
      },
    ],
    [FIND_BY_ID_QUERY, (params) => projects.filter((p) => p.projectId === params.projectId).map(toRow)],
    [FIND_BY_NAME_QUERY, (params) => projects.filter((p) => p.name === params.name).map(toRow)],
    [
      FIND_BY_DIRECTORY_NAME_QUERY,
      (params) => projects.filter((p) => p.path?.endsWith(params.directoryName)).map(toRow),
    ],
    [
      FIND_BY_PATH_PREFIXES_QUERY,
      (params) =>
        projects
          .filter((p) => p.path && params.pathPrefixes.some((prefix: string) => p.path!.startsWith(prefix)))
          .map(toRow),
    ],
    [
      FIND_BY_ROOT_CANDIDATES_QUERY,
      (params) =>
        projects
          .filter((p) => p.path && params.rootCandidates.includes(p.path) && params.kinds.includes(p.kind))
          .map(toRow),
    ],
    [
      FIND_EXISTING_IDS_QUERY,
      (params) =>
        projects.filter((p) => params.projectIds.includes(p.projectId)).map((p) => ({ projectId: p.projectId })),
    ],
    [
      LIST_RECENT_QUERY,
      (params) => projects.slice(0, params.limit).map((project) => ({ ...toRow(project), total: projects.length })),
    ],
  ]);

  const run = vi.fn(async (query: string, params: Row = {}): Promise<Row[]> => answers.get(query)?.(params) ?? []);

  return { run, projects };
};

export const writesTo = (run: ReturnType<typeof createProjectStore>['run'], query: string) =>
  run.mock.calls.filter(([executed]) => executed === query);
