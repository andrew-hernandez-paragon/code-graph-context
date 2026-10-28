import { stat } from 'fs/promises';

import type { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { toNumber, toNumberOrNull } from '../utils/shared-utils.js';

import { InvalidProjectInputError, NotACodebaseError, ProjectNotFoundError } from './project-errors.js';
import { collectionProjectId, generateProjectId, validateProjectId } from './project-ids.js';
import { PROJECT_KINDS, ParseStatus, ProjectKind, projectKindCypher } from './project-kinds.js';
import {
  containsPath,
  findGitLocation,
  isPathInput,
  normalizePath,
  pathBasename,
  rootCandidates,
} from './project-paths.js';
import {
  deepestEnclosingProjects,
  describeProject,
  describeProjects,
  hasPath,
  MAX_LISTED_PROJECTS,
  pickUniqueMatch,
  preferCodebase,
  rootOf,
  type RegisteredProject,
} from './project-resolution.js';
import type { Project, ProjectCreation, ProjectSummary } from './project-types.js';

const KIND_CYPHER = projectKindCypher('p');

const PROJECT_FIELDS = `
  p.projectId AS projectId, p.name AS name, ${KIND_CYPHER} AS kind, p.path AS path,
  p.description AS description, p.status AS status, p.nodeCount AS nodeCount,
  p.edgeCount AS edgeCount, p.updatedAt AS updatedAt`;

export const FIND_BY_ID_QUERY = `
  MATCH (p:Project {projectId: $projectId})
  RETURN ${PROJECT_FIELDS}
`;

export const FIND_BY_NAME_QUERY = `
  MATCH (p:Project)
  WHERE p.name = $name
  RETURN ${PROJECT_FIELDS}
  ORDER BY p.updatedAt DESC
`;

/** Narrows by suffix; the caller keeps the projects whose directory name is exactly the input. */
export const FIND_BY_DIRECTORY_NAME_QUERY = `
  MATCH (p:Project)
  WHERE p.path ENDS WITH $directoryName
  RETURN ${PROJECT_FIELDS}
  ORDER BY p.updatedAt DESC
`;

/** Narrows by prefix; the caller keeps the projects whose normalized path equals one of the inputs. */
export const FIND_BY_PATH_PREFIXES_QUERY = `
  MATCH (p:Project)
  WHERE any(prefix IN $pathPrefixes WHERE p.path STARTS WITH prefix)
  RETURN ${PROJECT_FIELDS}
  ORDER BY p.updatedAt DESC
`;

/** Projects whose stored path is one of the candidate roots; the caller checks containment. */
export const FIND_BY_ROOT_CANDIDATES_QUERY = `
  MATCH (p:Project)
  WHERE p.path IN $rootCandidates AND ${KIND_CYPHER} IN $kinds
  RETURN ${PROJECT_FIELDS}
  ORDER BY p.updatedAt DESC
`;

export const FIND_EXISTING_IDS_QUERY = `
  MATCH (p:Project)
  WHERE p.projectId IN $projectIds
  RETURN p.projectId AS projectId
`;

export const LIST_RECENT_QUERY = `
  MATCH (p:Project)
  RETURN ${PROJECT_FIELDS}, COUNT { MATCH (:Project) } AS total
  ORDER BY p.updatedAt DESC
  LIMIT toInteger($limit)
`;

export const LIST_WITH_MEMORY_QUERY = `
  MATCH (p:Project)
  WHERE ${KIND_CYPHER} IN $kinds
  RETURN ${PROJECT_FIELDS},
    COUNT {
      MATCH (n:SessionNote {projectId: p.projectId})
      WHERE n.supersededBy IS NULL AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())
    } AS liveNotes,
    COUNT { MATCH (b:SessionBookmark {projectId: p.projectId}) } AS bookmarks,
    COLLECT { MATCH (n:SessionNote {projectId: p.projectId}) RETURN n.createdAt ORDER BY n.createdAt DESC LIMIT 1 } AS lastNoteAt,
    COLLECT { MATCH (b:SessionBookmark {projectId: p.projectId}) RETURN b.createdAt ORDER BY b.createdAt DESC LIMIT 1 } AS lastBookmarkAt
  ORDER BY p.updatedAt DESC
`;

export const CREATE_PROJECT_QUERY = `
  MERGE (p:Project {projectId: $projectId})
  ON CREATE SET
    p.name = $name,
    p.kind = $kind,
    p.path = $path,
    p.description = $description,
    p.createdAt = datetime(),
    p.updatedAt = datetime()
  RETURN ${PROJECT_FIELDS}
`;

export const UPSERT_CODEBASE_QUERY = `
  MERGE (p:Project {projectId: $projectId})
  ON CREATE SET p.createdAt = datetime()
  SET p.name = $name,
      p.kind = 'codebase',
      p.path = $path,
      p.status = $status,
      p.updatedAt = datetime()
  RETURN p.projectId AS projectId
`;

const UPDATE_PARSE_STATUS_QUERY = `
  MATCH (p:Project {projectId: $projectId})
  SET p.status = $status,
      p.nodeCount = $nodeCount,
      p.edgeCount = $edgeCount,
      p.updatedAt = datetime()
  RETURN p.projectId AS projectId
`;

/** Selects only nodes without `kind`, so a second start writes nothing. */
export const BACKFILL_PROJECT_KINDS_QUERY = `
  MATCH (p:Project)
  WHERE p.kind IS NULL
  SET p.kind = ${KIND_CYPHER}
  REMOVE p.synthetic
  RETURN count(p) AS backfilled
`;

const trimmedOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed;
};

const toProject = (row: Record<string, unknown>): Project => ({
  projectId: row.projectId as string,
  name: (row.name as string | null) ?? (row.projectId as string),
  kind: row.kind as ProjectKind,
  path: (row.path as string | null) ?? null,
  description: (row.description as string | null) ?? null,
  status: (row.status as ParseStatus | null) ?? null,
  nodeCount: toNumberOrNull(row.nodeCount),
  edgeCount: toNumberOrNull(row.edgeCount),
  updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
});

const toIsoTimestamp = (millis: unknown): string | null =>
  millis == null ? null : new Date(toNumber(millis)).toISOString();

const latestOf = (...collected: unknown[]): string | null => {
  const times = collected.flatMap((values) => (Array.isArray(values) ? values : [])).map(toNumber);
  return times.length === 0 ? null : toIsoTimestamp(Math.max(...times));
};

/** Owns every Cypher statement on `:Project` nodes and the rules that turn an id, name or path into one. */
export class ProjectService {
  constructor(private readonly neo4j: Pick<Neo4jService, 'run'>) {}

  async findById(projectId: string): Promise<Project | null> {
    const rows = await this.neo4j.run(FIND_BY_ID_QUERY, { projectId });
    return rows.length > 0 ? toProject(rows[0]) : null;
  }

  /** For reads: id, then name, then directory name of a registered path, then the registered root enclosing a path. */
  async findProject(input: string): Promise<Project> {
    return this.resolve(input, { register: false });
  }

  /**
   * For writes. As findProject, and an unregistered git root that encloses the path is registered
   * as a directory. A name or an id never creates a project.
   */
  async findOrRegisterProject(input: string): Promise<Project> {
    return this.resolve(input, { register: true });
  }

  async findCodebase(input: string): Promise<Project> {
    const project = await this.findProject(input);
    if (project.kind !== 'codebase') {
      const next =
        project.kind === 'directory'
          ? `Run parse_typescript_project on ${project.path} to make it a codebase (its memories stay), or read its memories with session_recall.`
          : `Collections hold memories only; read them with session_recall, or call parse_typescript_project on a TypeScript repository.`;
      throw new NotACodebaseError(
        `Project '${project.name}' (${project.projectId}) is a ${project.kind}, but this tool needs a parsed codebase. ${next}`,
      );
    }
    return project;
  }

  async list(kinds: readonly ProjectKind[] = PROJECT_KINDS): Promise<ProjectSummary[]> {
    const rows = await this.neo4j.run(LIST_WITH_MEMORY_QUERY, { kinds: [...kinds] });
    return rows.map((row) => ({
      ...toProject(row),
      memory: {
        liveNotes: toNumber(row.liveNotes),
        bookmarks: toNumber(row.bookmarks),
        lastSavedAt: latestOf(row.lastNoteAt, row.lastBookmarkAt),
      },
    }));
  }

  /** Idempotent: an existing collection of that name comes back unchanged. */
  async createCollection(input: { name: string; description: string }): Promise<ProjectCreation> {
    const name = input.name.trim();
    const description = input.description.trim();
    if (description.length === 0) {
      throw new InvalidProjectInputError(
        `A collection needs a description of what belongs in it. Call create_project again with kind 'collection', name '${name}' and a description.`,
      );
    }

    const projectId = collectionProjectId(name);
    const existing = await this.findById(projectId);
    if (existing?.kind === 'collection') {
      if (existing.name !== name) {
        throw new InvalidProjectInputError(
          `The name '${name}' becomes collection id ${projectId}, which already belongs to the collection '${existing.name}'. Use that collection (projectId ${projectId}), or choose a name that differs in its first 40 characters.`,
        );
      }
      return { project: existing, created: false };
    }
    if (existing) {
      throw new InvalidProjectInputError(
        `Project id ${projectId} already belongs to ${describeProject(existing)}, which is not a collection. Pick another collection name, or use that project.`,
      );
    }

    const [sameName] = await this.queryProjects(FIND_BY_NAME_QUERY, { name });
    if (sameName) {
      throw new InvalidProjectInputError(
        `A project named '${name}' already exists: ${describeProject(sameName)}. A name must pick one project, so choose another collection name or use the existing project.`,
      );
    }

    const project = await this.createProject({ projectId, name, kind: 'collection', path: null, description });
    return { project, created: true };
  }

  /**
   * Idempotent. A project already registered at this exact path, under any id and of any kind,
   * is reused: a directory and a codebase at one path are the same project.
   */
  async registerDirectory(input: { path: string; name?: string; description?: string }): Promise<ProjectCreation> {
    const path = normalizePath(input.path);
    const isDirectory = await stat(path)
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    if (!isDirectory) {
      throw new InvalidProjectInputError(
        `Directory '${path}' does not exist or is not a directory. Pass an existing directory, or use kind 'collection' for memories that belong to no directory.`,
      );
    }

    const existing = await this.findRegisteredAt([path]);
    if (existing.length > 0) {
      return { project: preferCodebase(existing), created: false };
    }

    const name = trimmedOrNull(input.name) ?? pathBasename(path);
    const project = await this.createProject({
      projectId: generateProjectId(path),
      name,
      kind: 'directory',
      path,
      description: trimmedOrNull(input.description),
    });
    return { project, created: true };
  }

  /** The only writer of kind 'codebase', on every parse upsert. */
  async upsertCodebase(input: { projectId: string; name: string; path: string; status: ParseStatus }): Promise<void> {
    await this.neo4j.run(UPSERT_CODEBASE_QUERY, { ...input, path: normalizePath(input.path) });
  }

  async updateParseStatus(input: {
    projectId: string;
    status: ParseStatus;
    nodeCount: number;
    edgeCount: number;
  }): Promise<void> {
    await this.neo4j.run(UPDATE_PARSE_STATUS_QUERY, input);
  }

  /** The id a parse stores under: an explicit id wins, then the project already registered at this path, then a new path hash. */
  async chooseCodebaseId(projectPath: string, explicitProjectId?: string): Promise<string> {
    if (explicitProjectId) {
      if (!validateProjectId(explicitProjectId)) {
        throw new InvalidProjectInputError(
          `Invalid projectId '${explicitProjectId}'. Expected 'proj_' followed by 1 to 40 of a-z, 0-9, '_' or '-'. Omit projectId to reuse the project registered at this path.`,
        );
      }
      const existing = await this.findById(explicitProjectId);
      if (existing?.kind === 'collection') {
        throw new NotACodebaseError(
          `Project '${existing.name}' (${existing.projectId}) is a collection, which has no code to parse. Omit projectId, or pass a codebase or directory id.`,
        );
      }
      return explicitProjectId;
    }

    const path = normalizePath(projectPath);
    const registered = (await this.findProjectIdsByPath([path])).get(path);
    return registered ?? generateProjectId(path);
  }

  /** Registered project id for each path that has an exact match, keyed by the normalized path. */
  async findProjectIdsByPath(paths: readonly string[]): Promise<Map<string, string>> {
    const normalized = paths.map(normalizePath);
    const registered = await this.findRegisteredAt(normalized);
    const ids = new Map<string, string>();
    for (const path of normalized) {
      const atPath = registered.filter((project) => rootOf(project) === path);
      if (atPath.length > 0) ids.set(path, preferCodebase(atPath).projectId);
    }
    return ids;
  }

  /** The codebase whose root encloses each absolute path (the deepest root wins), keyed by path; paths outside every codebase are left out. */
  async findEnclosingCodebaseIds(paths: readonly string[]): Promise<Map<string, string>> {
    const roots = (await this.findRootsAround(paths, ['codebase']))
      .map((project) => ({ projectId: project.projectId, root: rootOf(project) }))
      .sort((a, b) => b.root.length - a.root.length);
    const ids = new Map<string, string>();
    for (const path of paths) {
      const enclosing = roots.find(({ root }) => containsPath(root, path));
      if (enclosing) ids.set(path, enclosing.projectId);
    }
    return ids;
  }

  /** The ids in `projectIds` that have no Project node. */
  async findUnregisteredIds(projectIds: readonly string[]): Promise<string[]> {
    const rows = await this.neo4j.run(FIND_EXISTING_IDS_QUERY, { projectIds: [...projectIds] });
    const known = new Set(rows.map((row) => row.projectId as string));
    return projectIds.filter((projectId) => !known.has(projectId));
  }

  /** Sets the kind on Project nodes written without one; returns how many it changed. */
  async backfillKinds(): Promise<number> {
    const rows = await this.neo4j.run(BACKFILL_PROJECT_KINDS_QUERY, {});
    return toNumber(rows[0]?.backfilled ?? 0);
  }

  private async queryProjects(query: string, params: Record<string, unknown>): Promise<Project[]> {
    return (await this.neo4j.run(query, params)).map(toProject);
  }

  /** Projects whose registered path is exactly one of `paths`, which are normalized. */
  private async findRegisteredAt(paths: readonly string[]): Promise<RegisteredProject[]> {
    const rows = await this.queryProjects(FIND_BY_PATH_PREFIXES_QUERY, { pathPrefixes: [...paths] });
    return rows.filter(hasPath).filter((project) => paths.includes(rootOf(project)));
  }

  /** Projects of `kinds` registered at a path or at an ancestor of one of `paths`. */
  private async findRootsAround(paths: readonly string[], kinds: readonly ProjectKind[]): Promise<RegisteredProject[]> {
    const rows = await this.queryProjects(FIND_BY_ROOT_CANDIDATES_QUERY, {
      rootCandidates: rootCandidates(paths),
      kinds: [...kinds],
    });
    return rows.filter(hasPath);
  }

  private async describeRegisteredProjects(): Promise<string> {
    const rows = await this.neo4j.run(LIST_RECENT_QUERY, { limit: MAX_LISTED_PROJECTS });
    return describeProjects(rows.map(toProject), rows.length === 0 ? 0 : toNumber(rows[0].total));
  }

  private async createProject(input: {
    projectId: string;
    name: string;
    kind: ProjectKind;
    path: string | null;
    description: string | null;
  }): Promise<Project> {
    const rows = await this.neo4j.run(CREATE_PROJECT_QUERY, input);
    return toProject(rows[0]);
  }

  private async resolve(input: string, options: { register: boolean }): Promise<Project> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new InvalidProjectInputError(
        'A project id, name or path is required. Call list_projects to see the registered projects.',
      );
    }

    return isPathInput(trimmed)
      ? this.resolvePath(normalizePath(trimmed), options.register)
      : this.resolveIdOrName(trimmed, options.register);
  }

  private async resolveIdOrName(input: string, register: boolean): Promise<Project> {
    const byId = await this.findById(input);
    if (byId) return byId;

    const byName = await this.queryProjects(FIND_BY_NAME_QUERY, { name: input });
    if (byName.length > 0) return pickUniqueMatch(byName, input, 'name');

    const byDirectoryName = (await this.queryProjects(FIND_BY_DIRECTORY_NAME_QUERY, { directoryName: input }))
      .filter(hasPath)
      .filter((project) => pathBasename(project.path) === input);
    if (byDirectoryName.length > 0) return pickUniqueMatch(byDirectoryName, input, 'directory name');

    const createStep = register
      ? "Writes never create a project from a name or id: call create_project with kind 'collection' and this name, or with kind 'directory' and a path."
      : 'Call list_projects to see them, create_project to add a collection or directory, or parse_typescript_project for a TypeScript repository.';
    throw new ProjectNotFoundError(
      `No project has id, name or directory name '${input}'. Registered projects: ${await this.describeRegisteredProjects()}. ${createStep}`,
    );
  }

  private async resolvePath(target: string, register: boolean): Promise<Project> {
    const git = await findGitLocation(target);
    const location = git?.path ?? target;

    const registered = deepestEnclosingProjects(
      await this.findRootsAround([location], ['codebase', 'directory']),
      location,
    );
    if (registered.length > 0 && (!git || git.root.length <= rootOf(registered[0]).length)) {
      return preferCodebase(registered);
    }

    if (git && register) {
      return (await this.registerDirectory({ path: git.root })).project;
    }

    const searched = git
      ? `It is inside the git repository ${git.root}, which is not registered.`
      : 'It is not inside a registered project or a git repository.';
    const next = register
      ? "Call create_project with kind 'directory' and this path, or with kind 'collection' for memories that belong to no directory."
      : "Call create_project with kind 'directory' and this path, or parse_typescript_project if it is a TypeScript repository.";
    throw new ProjectNotFoundError(
      `No registered project contains ${target}. ${searched} Registered projects: ${await this.describeRegisteredProjects()}. ${next}`,
    );
  }
}
