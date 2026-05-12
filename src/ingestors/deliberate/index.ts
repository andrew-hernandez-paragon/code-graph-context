/**
 * Deliberate JSONL ingestor package.
 *
 * Reads deliberation.jsonl from a data directory and produces idempotent
 * MERGE cypher for Deliberation / Position / Verdict nodes (plus HAS_POSITION,
 * RESULTED_IN, SCOPED_TO, and ABOUT edges).
 *
 * See proposal 0004-consensus-protocol-deliberation for schema + rationale.
 */

import { isSyntheticProjectId } from '../../core/utils/project-id.js';

import { mergeAbout, mergeDeliberation, mergeScopedTo } from './merge-deliberation.js';
import { mergeCites, mergeHasPosition, mergePosition } from './merge-position.js';
import { mergeResultedIn, mergeVerdict } from './merge-verdict.js';
import { DeliberateEventRow, DeliberationRow, PositionRow, VerdictRow, readDeliberateJsonls } from './read-jsonl.js';

export type { CypherEmit } from '../cursordiff/merge-toolcall.js';
export type { DeliberateEventRow, DeliberationRow, PositionRow, VerdictRow } from './read-jsonl.js';
export { readDeliberateJsonls } from './read-jsonl.js';

export interface DeliberateIngestOptions {
  dataDir: string;
}

export interface DeliberateIngestStats {
  eventRows: number;
  deliberations: number;
  positions: number;
  verdicts: number;
  scopedToEdges: number;
  aboutEdges: number;
  syntheticProjects: number;
}

export interface DeliberateIngestPlan {
  emits: ReturnType<typeof mergeDeliberation>[];
  projectIds: string[];
  stats: DeliberateIngestStats;
}

/**
 * Read deliberation.jsonl and build idempotent MERGE cypher statements.
 * Caller either prints them (dry-run) or executes against Neo4j (live mode).
 *
 * Every write is a MERGE, so re-running over the same JSONL is a no-op.
 */
export const planIngestDeliberate = (opts: DeliberateIngestOptions): DeliberateIngestPlan => {
  const { events } = readDeliberateJsonls(opts.dataDir);

  const emits: ReturnType<typeof mergeDeliberation>[] = [];
  const seenDeliberations = new Set<string>();
  const seenPositions = new Set<string>();
  const seenVerdicts = new Set<string>();
  const seenScopedTo = new Set<string>();
  const seenAbout = new Set<string>();
  const allProjectIds = new Set<string>();
  let syntheticCount = 0;

  // Separate event types for processing
  const deliberationRows: DeliberationRow[] = [];
  const positionRows: PositionRow[] = [];
  const verdictRows: VerdictRow[] = [];

  for (const event of events) {
    if (event.type === 'deliberation-start' || event.type === 'deliberation-complete' || event.type === 'deliberation-aborted') {
      deliberationRows.push(event as DeliberationRow);
    } else if (event.type === 'position-start' || event.type === 'position-complete') {
      positionRows.push(event as PositionRow);
    } else if (event.type === 'verdict') {
      verdictRows.push(event as VerdictRow);
    }
  }

  // Process deliberations
  for (const row of deliberationRows) {
    if (!seenDeliberations.has(row.id)) {
      emits.push({
        ...mergeDeliberation(row),
        comment: `Deliberation ${row.id} (topic=${row.topic})`,
      });
      seenDeliberations.add(row.id);

      // SCOPED_TO edges — one per projectId
      for (const projectId of row.projectIds ?? []) {
        const key = `${row.id}|${projectId}`;
        if (!seenScopedTo.has(key)) {
          emits.push({
            ...mergeScopedTo(row.id, projectId),
            comment: `SCOPED_TO: ${row.id} → ${projectId}`,
          });
          seenScopedTo.add(key);
          allProjectIds.add(projectId);
          if (isSyntheticProjectId(projectId)) syntheticCount++;
        }
      }

      // ABOUT edges — one per aboutNodeId
      for (const nodeId of row.aboutNodeIds ?? []) {
        const key = `${row.id}|${nodeId}`;
        if (!seenAbout.has(key)) {
          emits.push({
            ...mergeAbout(row.id, nodeId, 'primary'),
            comment: `ABOUT: ${row.id} → ${nodeId}`,
          });
          seenAbout.add(key);
        }
      }
    }
  }

  // Process positions
  for (const row of positionRows) {
    if (!seenPositions.has(row.id)) {
      emits.push({
        ...mergePosition(row),
        comment: `Position ${row.id} (role=${row.role}, status=${row.status})`,
      });
      seenPositions.add(row.id);

      emits.push({
        ...mergeHasPosition(row.deliberationId, row.id),
        comment: `HAS_POSITION: ${row.deliberationId} → ${row.id}`,
      });
    }
  }

  // Process verdicts
  for (const row of verdictRows) {
    if (!seenVerdicts.has(row.id)) {
      emits.push({
        ...mergeVerdict(row),
        comment: `Verdict ${row.id} (verdict=${row.verdict})`,
      });
      seenVerdicts.add(row.id);

      emits.push({
        ...mergeResultedIn(row.deliberationId, row.id),
        comment: `RESULTED_IN: ${row.deliberationId} → ${row.id}`,
      });
    }
  }

  return {
    emits,
    projectIds: Array.from(allProjectIds),
    stats: {
      eventRows: events.length,
      deliberations: seenDeliberations.size,
      positions: seenPositions.size,
      verdicts: seenVerdicts.size,
      scopedToEdges: seenScopedTo.size,
      aboutEdges: seenAbout.size,
      syntheticProjects: syntheticCount,
    },
  };
};

/**
 * Build CITES edges from a Position's evidence node IDs.
 * Called separately because citations are optional and may reference
 * nodes in other projects.
 */
export const planCitesEdges = (
  positionId: string,
  evidenceNodeIds: string[],
  counterExampleNodeIds: string[],
): ReturnType<typeof mergeCites>[] => {
  const emits: ReturnType<typeof mergeCites>[] = [];
  for (const nodeId of evidenceNodeIds) {
    emits.push({ ...mergeCites(positionId, nodeId, 'evidence'), comment: `CITES evidence: ${positionId} → ${nodeId}` });
  }
  for (const nodeId of counterExampleNodeIds) {
    emits.push({
      ...mergeCites(positionId, nodeId, 'counter-example'),
      comment: `CITES counter-example: ${positionId} → ${nodeId}`,
    });
  }
  return emits;
};
