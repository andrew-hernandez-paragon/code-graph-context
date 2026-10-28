import { AmbiguousProjectError } from './project-errors.js';
import { containsPath, normalizePath } from './project-paths.js';
import type { Project } from './project-types.js';

export const MAX_LISTED_PROJECTS = 10;

export type RegisteredProject = Project & { path: string };

export const hasPath = (project: Project): project is RegisteredProject => project.path !== null;

/** The project's directory in the form paths are compared in. */
export const rootOf = (project: RegisteredProject): string => normalizePath(project.path);

export const describeProject = (project: Project): string =>
  `${project.name} (${project.projectId}, ${project.kind}${project.path ? `, ${project.path}` : ''})`;

/** Lists up to ten projects; `total` is the count when `projects` is only the first part of the registry. */
export const describeProjects = (projects: readonly Project[], total: number = projects.length): string => {
  if (total === 0) return 'none';
  const shown = projects.slice(0, MAX_LISTED_PROJECTS).map(describeProject).join('; ');
  const hidden = total - Math.min(projects.length, MAX_LISTED_PROJECTS);
  return hidden > 0 ? `${shown}; and ${hidden} more` : shown;
};

/** One project at a path: a codebase wins over a directory, and several of the same kind are ambiguous. */
export const preferCodebase = <T extends Project>(projects: readonly T[]): T => {
  const codebases = projects.filter((project) => project.kind === 'codebase');
  const candidates = codebases.length > 0 ? codebases : projects;
  if (candidates.length > 1) {
    throw new AmbiguousProjectError(
      `More than one project is registered at ${candidates[0].path}: ${describeProjects(candidates)}. Use the projectId to choose one.`,
    );
  }
  return candidates[0];
};

export const pickUniqueMatch = <T extends Project>(matches: readonly T[], input: string, matchedBy: string): T => {
  if (matches.length > 1) {
    throw new AmbiguousProjectError(
      `'${input}' matches more than one project by ${matchedBy}: ${describeProjects(matches)}. Pass the projectId of the one you mean.`,
    );
  }
  return matches[0];
};

/** The projects registered at the deepest root that contains `location`; empty when no root does. */
export const deepestEnclosingProjects = (
  projects: readonly RegisteredProject[],
  location: string,
): RegisteredProject[] => {
  const enclosing = projects
    .filter((project) => containsPath(rootOf(project), location))
    .sort((a, b) => rootOf(b).length - rootOf(a).length);
  if (enclosing.length === 0) return [];
  const deepestRoot = rootOf(enclosing[0]);
  return enclosing.filter((project) => rootOf(project) === deepestRoot);
};
