/**
 * Session edge recovery (Phase 1.4)
 *
 * After `CLEAR_PROJECT` runs (which preserves SessionNote, SessionBookmark,
 * Pheromone, and Project nodes per the denylist in `neo4j.service.ts`),
 * code nodes are deleted and rebuilt with deterministic IDs. The :ABOUT,
 * :REFERENCES, and :MARKS edges from preserved nodes to deleted code nodes
 * died with the code nodes — recreate them by matching against the rebuilt
 * graph using the IDs persisted on each preserved node:
 *
 * - SessionNote.aboutNodeIds       (added as a property in Phase 1.3)
 * - SessionBookmark.workingSetNodeIds  (already a property)
 * - Pheromone.nodeId               (already a property)
 *
 * All recovery queries are idempotent (`MERGE`) — safe to run more than once.
 * Orphan references (IDs no longer present in the graph after reparse) are
 * surfaced via `COUNT_STALE_ABOUT_REFS` so the user can decide whether to
 * mark the affected notes stale.
 */

import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { debugLog } from '../utils.js';

export interface SessionEdgeRecoveryResult {
  aboutEdges: number;
  referencesEdges: number;
  marksEdges: number;
  staleAboutRefs: number;
}

const toNumber = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v && 'toNumber' in (v as object)) {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v) || 0;
};

/**
 * Recreate :ABOUT, :REFERENCES, and :MARKS edges from preserved
 * session/coordination nodes to (possibly newly recreated) code nodes.
 *
 * Idempotent — safe to call multiple times. Failures in any single query
 * are logged and reported as zero counts; partial recovery is preferable
 * to throwing and aborting the whole parse.
 */
export const recoverSessionEdges = async (
  neo4jService: Neo4jService,
  projectId: string,
): Promise<SessionEdgeRecoveryResult> => {
  const runOne = async (query: string, label: string): Promise<number> => {
    try {
      const rows = await neo4jService.run(query, { projectId });
      return toNumber(rows[0]?.recreated ?? rows[0]?.staleCount);
    } catch (error) {
      await debugLog('Session edge recovery: query failed (non-fatal)', {
        label,
        error: String(error),
      });
      return 0;
    }
  };

  const [aboutEdges, referencesEdges, marksEdges, staleAboutRefs] = await Promise.all([
    runOne(QUERIES.RECREATE_ABOUT_EDGES, 'RECREATE_ABOUT_EDGES'),
    runOne(QUERIES.RECREATE_REFERENCES_EDGES, 'RECREATE_REFERENCES_EDGES'),
    runOne(QUERIES.RECREATE_MARKS_EDGES, 'RECREATE_MARKS_EDGES'),
    runOne(QUERIES.COUNT_STALE_ABOUT_REFS, 'COUNT_STALE_ABOUT_REFS'),
  ]);

  await debugLog('Session edge recovery complete', {
    projectId,
    aboutEdges,
    referencesEdges,
    marksEdges,
    staleAboutRefs,
  });

  return { aboutEdges, referencesEdges, marksEdges, staleAboutRefs };
};

/**
 * Format a one-line summary suitable for inclusion in parse-success messages.
 * Returns empty string when there's nothing meaningful to report so the parse
 * output stays clean for fresh-project / no-session-data cases.
 */
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
