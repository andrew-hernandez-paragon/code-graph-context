/**
 * `code-graph-context project delete`: remove a project, moving or deleting the memory it holds.
 *
 * Exit codes: 0 when the project was deleted, was previewed, or the operator declined; 1 when it was refused or failed.
 */

import { createInterface } from 'readline/promises';

import {
  ProjectDeletionPlan,
  ProjectDeletionService,
  ProjectError,
  type LabelCounts,
  type ProjectDeletionOptions,
} from '../core/projects/index.js';

export interface ProjectDeleteOptions extends ProjectDeletionOptions {
  dryRun?: boolean;
  yes?: boolean;
}

export interface ProjectDeleteDependencies {
  deletion: Pick<ProjectDeletionService, 'planDeletion' | 'executeDeletion'>;
  confirm: (question: string) => Promise<boolean>;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

export const confirmOnTerminal = async (question: string): Promise<boolean> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `)).trim());
  } finally {
    terminal.close();
  }
};

const describeCounts = (counts: LabelCounts): string[] => {
  const entries = Object.entries(counts);
  return entries.length === 0 ? ['  (none)'] : entries.map(([label, count]) => `  ${label}: ${count}`);
};

const describePlan = (plan: ProjectDeletionPlan): string[] => {
  const { project, target } = plan;
  return [
    `Project: ${project.name} (${project.projectId}, ${project.kind})`,
    target ? `Memory moves to: ${target.name} (${target.projectId})` : 'Memory: none kept',
    'Nodes moved:',
    ...describeCounts(plan.moved),
    ...(target
      ? [
          `  anchors pruned (ids into ${project.projectId}): ${plan.prunedAnchors.aboutNodeIds} aboutNodeIds, ${plan.prunedAnchors.workingSetNodeIds} workingSetNodeIds`,
        ]
      : []),
    `Deliberations re-scoped${target ? ' to the target' : ' (id removed)'}: ${plan.deliberations}`,
    'Nodes deleted:',
    ...describeCounts(plan.deleted),
  ];
};

export const runProjectDelete = async (
  projectInput: string,
  options: ProjectDeleteOptions,
  deps: ProjectDeleteDependencies,
): Promise<number> => {
  try {
    const plan = await deps.deletion.planDeletion(projectInput, options);
    const lines = describePlan(plan);

    if (options.dryRun) {
      deps.writeStdout(['Dry run, nothing was written.', ...lines].join('\n'));
      return 0;
    }
    if (!options.yes) {
      deps.writeStdout(lines.join('\n'));
      if (!(await deps.confirm(`Delete project ${plan.project.projectId}? This cannot be undone.`))) {
        deps.writeStdout('Cancelled, nothing was written.');
        return 0;
      }
    }

    await deps.deletion.executeDeletion(plan);
    deps.writeStdout(['Deleted.', ...lines].join('\n'));
    return 0;
  } catch (error) {
    if (error instanceof ProjectError) {
      deps.writeStderr(error.message);
      return 1;
    }
    throw error;
  }
};
