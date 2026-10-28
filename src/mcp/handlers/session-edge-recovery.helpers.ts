/**
 * Session edge recovery
 * After a reparse deletes and rebuilds code nodes, recreates the :ABOUT, :REFERENCES and :MARKS edges that
 * preserved session nodes had to them, matching on the ids and paths stored on each preserved node.
 */

import { sep } from 'path';

import { normalizePath, ProjectService } from '../../core/projects/index.js';
import { toNumber } from '../../core/utils/shared-utils.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { debugLog } from '../utils.js';

export interface SessionEdgeRecoveryResult {
  aboutEdges: number;
  referencesEdges: number;
  marksEdges: number;
  staleAboutRefs: number;
}

const findProjectRoot = async (neo4jService: Neo4jService, projectId: string): Promise<string | null> => {
  try {
    return (await new ProjectService(neo4jService).findById(projectId))?.path ?? null;
  } catch (error) {
    await debugLog('Session edge recovery: project lookup failed, path anchors are not relinked (non-fatal)', {
      projectId,
      error: String(error),
    });
    return null;
  }
};

/**
 * Recreate :ABOUT, :REFERENCES, and :MARKS edges from preserved
 * session/coordination nodes to (possibly newly recreated) code nodes.
 *
 * Idempotent, safe to call multiple times. Failures in any single query
 * are logged and reported as zero counts; partial recovery is preferable
 * to throwing and aborting the whole parse.
 */
export const recoverSessionEdges = async (
  neo4jService: Neo4jService,
  projectId: string,
): Promise<SessionEdgeRecoveryResult> => {
  const root = await findProjectRoot(neo4jService, projectId);
  const params = {
    projectId,
    projectIdPrefix: `${projectId}:`,
    // A project without a directory has no paths under it.
    rootPrefix: root === null ? null : `${normalizePath(root).replace(/[\\/]+$/, '')}${sep}`,
  };

  const runOne = async (query: string, label: string): Promise<number> => {
    try {
      const rows = await neo4jService.run(query, params);
      return toNumber(rows[0]?.recreated ?? rows[0]?.staleCount);
    } catch (error) {
      await debugLog('Session edge recovery: query failed (non-fatal)', {
        label,
        error: String(error),
      });
      return 0;
    }
  };

  const [aboutNodeEdges, aboutPathEdges, referencesNodeEdges, referencesPathEdges, marksEdges, staleAboutRefs] =
    await Promise.all([
      runOne(QUERIES.RECREATE_ABOUT_EDGES, 'RECREATE_ABOUT_EDGES'),
      runOne(QUERIES.RECREATE_ABOUT_PATH_EDGES, 'RECREATE_ABOUT_PATH_EDGES'),
      runOne(QUERIES.RECREATE_REFERENCES_EDGES, 'RECREATE_REFERENCES_EDGES'),
      runOne(QUERIES.RECREATE_REFERENCES_PATH_EDGES, 'RECREATE_REFERENCES_PATH_EDGES'),
      runOne(QUERIES.RECREATE_MARKS_EDGES, 'RECREATE_MARKS_EDGES'),
      runOne(QUERIES.COUNT_STALE_ABOUT_REFS, 'COUNT_STALE_ABOUT_REFS'),
    ]);
  const aboutEdges = aboutNodeEdges + aboutPathEdges;
  const referencesEdges = referencesNodeEdges + referencesPathEdges;

  await debugLog('Session edge recovery complete', {
    projectId,
    aboutEdges,
    referencesEdges,
    marksEdges,
    staleAboutRefs,
  });

  return { aboutEdges, referencesEdges, marksEdges, staleAboutRefs };
};

/** A one-line summary for parse-success messages; empty when nothing was restored. */
export const formatSessionEdgeRecoverySummary = (result: SessionEdgeRecoveryResult): string => {
  const total = result.aboutEdges + result.referencesEdges + result.marksEdges;
  if (total === 0 && result.staleAboutRefs === 0) {
    return '';
  }
  const parts: string[] = [];
  if (result.aboutEdges > 0) parts.push(`${result.aboutEdges} :ABOUT`);
  if (result.referencesEdges > 0) parts.push(`${result.referencesEdges} :REFERENCES`);
  if (result.marksEdges > 0) parts.push(`${result.marksEdges} :MARKS`);
  let summary = `Session edges restored: ${parts.join(', ') || '0'}`;
  if (result.staleAboutRefs > 0) {
    summary += `. Stale references (note → missing code): ${result.staleAboutRefs}.`;
  }
  return summary;
};
