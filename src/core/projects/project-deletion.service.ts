import type { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { toNumber } from '../utils/shared-utils.js';

import { InvalidProjectInputError, ProjectDeletionRefusedError } from './project-errors.js';
import type { Project } from './project-types.js';
import type { ProjectService } from './project.service.js';

/** Labels of the memory a project holds; they are moved or deleted by an explicit choice, never as a side effect. */
export const MEMORY_LABELS = ['SessionNote', 'SessionNoteChunk', 'SessionBookmark'] as const;

export const COUNT_PROJECT_NODES_QUERY = `
  MATCH (n) WHERE n.projectId = $projectId
  RETURN labels(n) AS labels, count(n) AS count
`;

export const COUNT_SCOPED_DELIBERATIONS_QUERY = `
  MATCH (d:Deliberation) WHERE $projectId IN d.projectIds
  RETURN count(d) AS count
`;

export const COUNT_UNRESOLVABLE_ANCHORS_QUERY = `
  MATCH (n) WHERE n.projectId = $projectId AND (n:SessionNote OR n:SessionBookmark)
  RETURN
    sum(size([id IN coalesce(n.aboutNodeIds, []) WHERE id STARTS WITH $idPrefix])) AS aboutNodeIds,
    sum(size([id IN coalesce(n.workingSetNodeIds, []) WHERE id STARTS WITH $idPrefix])) AS workingSetNodeIds
`;

/** Anchors by node id into the deleted project can never resolve again; aboutPaths do not depend on the project and stay. */
export const MOVE_MEMORY_QUERY = `
  MATCH (n) WHERE n.projectId = $projectId AND (n:SessionNote OR n:SessionNoteChunk OR n:SessionBookmark)
  SET n.projectId = $targetProjectId,
      n.aboutNodeIds = CASE WHEN n.aboutNodeIds IS NULL THEN null
        ELSE [id IN n.aboutNodeIds WHERE NOT id STARTS WITH $idPrefix] END,
      n.workingSetNodeIds = CASE WHEN n.workingSetNodeIds IS NULL THEN null
        ELSE [id IN n.workingSetNodeIds WHERE NOT id STARTS WITH $idPrefix] END
  RETURN labels(n) AS labels, count(n) AS count
`;

/** Replaces the id with the target, without duplicates, and scopes each deliberation to the target Project. */
export const RESCOPE_DELIBERATIONS_QUERY = `
  MATCH (d:Deliberation) WHERE $projectId IN d.projectIds
  MATCH (target:Project {projectId: $targetProjectId})
  SET d.projectIds = reduce(ids = [], id IN d.projectIds |
    CASE
      WHEN id = $projectId AND $targetProjectId IN ids THEN ids
      WHEN id = $projectId THEN ids + [$targetProjectId]
      WHEN id IN ids THEN ids
      ELSE ids + [id]
    END)
  MERGE (d)-[:SCOPED_TO]->(target)
  RETURN count(d) AS count
`;

export const UNSCOPE_DELIBERATIONS_QUERY = `
  MATCH (d:Deliberation) WHERE $projectId IN d.projectIds
  SET d.projectIds = [id IN d.projectIds WHERE id <> $projectId]
  RETURN count(d) AS count
`;

/** Every node still carrying the project id except the Project, which goes last so a failed run can be repeated. */
export const DELETE_PROJECT_NODES_QUERY = `
  CALL apoc.periodic.iterate(
    'MATCH (n) WHERE n.projectId = $projectId AND NOT n:Project RETURN n',
    'DETACH DELETE n',
    {batchSize: 1000, params: {projectId: $projectId}}
  )
  YIELD total, failedBatches, errorMessages
  RETURN total, failedBatches, errorMessages
`;

export type LabelCounts = Record<string, number>;

export interface ProjectDeletionOptions {
  moveMemoryTo?: string;
  deleteMemory?: boolean;
}

export interface ProjectDeletionPlan {
  project: Project;
  /** Where the memory goes; null when the memory is deleted or there is none. */
  target: Project | null;
  /** Nodes that move to the target, by label set. */
  moved: LabelCounts;
  /** Nodes deleted with the project, by label set. */
  deleted: LabelCounts;
  deliberations: number;
  prunedAnchors: { aboutNodeIds: number; workingSetNodeIds: number };
}

const labelKey = (labels: readonly string[]): string => [...labels].sort().join(':');

const isMemory = (labels: readonly string[]): boolean =>
  labels.some((label) => (MEMORY_LABELS as readonly string[]).includes(label));

/** Plans and carries out the removal of a project and what it holds. */
export class ProjectDeletionService {
  constructor(
    private readonly projects: ProjectService,
    private readonly neo4j: Pick<Neo4jService, 'run'>,
  ) {}

  /** Reads only. Throws when the project holds memory and the options do not say what to do with it. */
  async planDeletion(projectInput: string, options: ProjectDeletionOptions): Promise<ProjectDeletionPlan> {
    if (options.moveMemoryTo && options.deleteMemory) {
      throw new InvalidProjectInputError(
        'Pass either --move-memory-to <project> or --delete-memory, not both: one moves the memory and the other deletes it.',
      );
    }
    const project = await this.projects.findProject(projectInput);
    const target = options.moveMemoryTo ? await this.projects.findProject(options.moveMemoryTo) : null;
    if (target?.projectId === project.projectId) {
      throw new InvalidProjectInputError(
        `--move-memory-to resolves to the project being deleted (${project.projectId}). Pass a different project or collection.`,
      );
    }

    const present = await this.countNodesByLabels(project.projectId);
    const memory = present.filter(({ labels }) => isMemory(labels));
    const memoryCount = memory.reduce((total, { count }) => total + count, 0);
    if (memoryCount > 0 && !target && !options.deleteMemory) {
      const counts = memory.map(({ labels, count }) => `${count} ${labelKey(labels)}`).join(', ');
      throw new ProjectDeletionRefusedError(
        `Project '${project.name}' (${project.projectId}) holds memory: ${counts}. Deleting it would lose that memory. Pass --move-memory-to <project> to keep it in another project or collection, or --delete-memory to delete it too.`,
      );
    }

    const toLabelCounts = (rows: typeof present): LabelCounts =>
      Object.fromEntries(rows.map(({ labels, count }) => [labelKey(labels), count]));
    const keepsMemory = target !== null;
    const moved = toLabelCounts(keepsMemory ? memory : []);
    const deleted = toLabelCounts(present.filter(({ labels }) => !keepsMemory || !isMemory(labels)));

    const deliberationRows = await this.neo4j.run(COUNT_SCOPED_DELIBERATIONS_QUERY, { projectId: project.projectId });
    const anchorRows = keepsMemory
      ? await this.neo4j.run(COUNT_UNRESOLVABLE_ANCHORS_QUERY, {
          projectId: project.projectId,
          idPrefix: `${project.projectId}:`,
        })
      : [];
    return {
      project,
      target,
      moved,
      deleted,
      deliberations: toNumber(deliberationRows[0]?.count ?? 0),
      prunedAnchors: {
        aboutNodeIds: toNumber(anchorRows[0]?.aboutNodeIds ?? 0),
        workingSetNodeIds: toNumber(anchorRows[0]?.workingSetNodeIds ?? 0),
      },
    };
  }

  /**
   * Order matters: memory moves first, then deliberations, then the remaining nodes, then the Project.
   * Each step is repeatable, so a run that stopped part way is finished by running the command again.
   */
  async executeDeletion(plan: ProjectDeletionPlan): Promise<void> {
    const { project, target } = plan;
    const params = { projectId: project.projectId, idPrefix: `${project.projectId}:` };

    if (target) {
      await this.neo4j.run(MOVE_MEMORY_QUERY, { ...params, targetProjectId: target.projectId });
      await this.neo4j.run(RESCOPE_DELIBERATIONS_QUERY, { ...params, targetProjectId: target.projectId });
    } else {
      await this.neo4j.run(UNSCOPE_DELIBERATIONS_QUERY, params);
    }

    const [deletion] = await this.neo4j.run(DELETE_PROJECT_NODES_QUERY, { projectId: project.projectId });
    if (toNumber(deletion?.failedBatches ?? 0) > 0) {
      throw new Error(
        `Deleting the nodes of ${project.projectId} failed: ${JSON.stringify(deletion.errorMessages)}. Nothing else was removed; run the command again.`,
      );
    }
    await this.projects.deleteProject(project.projectId);
  }

  private async countNodesByLabels(projectId: string): Promise<{ labels: string[]; count: number }[]> {
    const rows = await this.neo4j.run(COUNT_PROJECT_NODES_QUERY, { projectId });
    return rows.map((row) => ({ labels: row.labels as string[], count: toNumber(row.count) }));
  }
}
