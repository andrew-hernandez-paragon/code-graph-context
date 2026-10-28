import { type Project, type ProjectService, projectIdOfNodeId } from '../../core/projects/index.js';
import { fingerprintAnchorPaths, missingPathsOf, normalizeAnchorPaths } from '../../core/session/anchor-paths.js';
import type { Neo4jService } from '../../storage/neo4j/neo4j.service.js';

export interface NodeRef {
  id: string;
  projectId: string;
}

export interface SourceFileRef {
  projectId: string;
  filePath: string;
}

/** What a note or bookmark anchors to, checked against the graph and the disk at write time. */
export interface ResolvedAnchors {
  nodeIds: string[];
  /** Node ids that name a project; the write queries match each on its own project and id. */
  nodeRefs: NodeRef[];
  unresolvedNodeIds: string[];
  /** Absolute paths. */
  paths: string[];
  /** One sha256 per path, in the same order; empty for a folder or a missing path. */
  pathHashes: string[];
  missingPaths: string[];
  partiallyHashedPaths: string[];
  /** Paths inside a codebase, to link to that codebase's SourceFile when it has one. */
  sourceFileRefs: SourceFileRef[];
}

const FIND_RESOLVED_NODE_IDS_QUERY = `
  UNWIND $nodeRefs AS ref
  MATCH (target:GraphNode {id: ref.id, projectId: ref.projectId})
  RETURN collect(target.id) AS resolvedIds
`;

/** Checks the nodes and paths a note or bookmark anchors to against the graph and the disk. */
export class SessionAnchorService {
  constructor(
    private readonly projects: Pick<ProjectService, 'findEnclosingCodebaseIds'>,
    private readonly db: Pick<Neo4jService, 'run'>,
  ) {}

  async resolveAnchors(
    project: Project,
    input: { nodeIds: readonly string[]; paths: readonly string[] },
  ): Promise<ResolvedAnchors> {
    const nodeIds = [...new Set(input.nodeIds)];
    const nodeRefs = nodeIds.flatMap((id) => {
      const projectId = projectIdOfNodeId(id);
      return projectId ? [{ id, projectId }] : [];
    });
    const resolvedIds =
      nodeRefs.length === 0
        ? new Set<string>()
        : new Set<string>((await this.db.run(FIND_RESOLVED_NODE_IDS_QUERY, { nodeRefs }))[0]?.resolvedIds ?? []);

    const paths = normalizeAnchorPaths(input.paths, project);
    const fingerprints = await fingerprintAnchorPaths(paths);
    const enclosingCodebases =
      paths.length === 0 ? new Map<string, string>() : await this.projects.findEnclosingCodebaseIds(paths);

    return {
      nodeIds,
      nodeRefs,
      unresolvedNodeIds: nodeIds.filter((id) => !resolvedIds.has(id)),
      paths,
      pathHashes: fingerprints.map(({ hash }) => hash),
      missingPaths: missingPathsOf(fingerprints),
      partiallyHashedPaths: fingerprints.filter(({ partial }) => partial).map(({ path }) => path),
      sourceFileRefs: paths.flatMap((filePath) => {
        const projectId = enclosingCodebases.get(filePath);
        return projectId ? [{ projectId, filePath }] : [];
      }),
    };
  }
}
