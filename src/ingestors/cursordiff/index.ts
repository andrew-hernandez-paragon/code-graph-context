/**
 * cursordiff JSONL ingestor package.
 *
 * Reads router.jsonl + lineage.jsonl + decisions.jsonl from a data directory
 * and produces idempotent MERGE cypher for ToolCall / Hunk / Decision nodes
 * (plus PRODUCED and RESOLVED_BY edges).
 *
 * See proposal 0001-tool-call-decision-lineage for schema + rationale.
 */

import { resolve as resolvePath } from 'path';

import { generateProjectId } from '../../core/projects/index.js';

import { mergeDecision } from './merge-decision.js';
import { mergeHunk, mergeProduced } from './merge-hunk.js';
import { mergeToolCall, mergeTouched } from './merge-toolcall.js';
import { readCursordiffJsonls, RouterRow } from './read-jsonl.js';

export type { CypherEmit } from './merge-toolcall.js';
export type { DecisionRow, LineageRow, RouterRow } from './read-jsonl.js';
export { readCursordiffJsonls } from './read-jsonl.js';

/**
 * Walk up from `cwd` looking for an enclosing parsed project root. Returns
 * the longest root that is a prefix of cwd, with the id that root is registered
 * under (a hash of the root only when it is not registered), or a path-hash id
 * flagged `outsideParsedRoots` when no root matches.
 */
const projectIdFor = (
  cwd: string | undefined,
  parsedRoots: string[],
  registeredProjectIds: ReadonlyMap<string, string>,
): { projectId: string; outsideParsedRoots: boolean; matchedRoot?: string } => {
  if (!cwd) {
    return { projectId: generateProjectId('/'), outsideParsedRoots: true };
  }
  const abs = resolvePath(cwd);
  let bestRoot: string | undefined;
  for (const root of parsedRoots) {
    if (abs === root || abs.startsWith(root + '/')) {
      if (!bestRoot || root.length > bestRoot.length) bestRoot = root;
    }
  }
  if (bestRoot) {
    return {
      projectId: registeredProjectIds.get(resolvePath(bestRoot)) ?? generateProjectId(bestRoot),
      outsideParsedRoots: false,
      matchedRoot: bestRoot,
    };
  }
  return { projectId: generateProjectId(abs), outsideParsedRoots: true };
};

export interface IngestOptions {
  dataDir: string;
  parsedRoots: string[];
  /** Registered project id for each parsed root, from ProjectService.findProjectIdsByPath. */
  registeredProjectIds: ReadonlyMap<string, string>;
}

export interface IngestStats {
  routerRows: number;
  lineageRows: number;
  decisionRows: number;
  toolCalls: number;
  hunks: number;
  decisions: number;
  /** ToolCalls whose working directory is inside no parsed root. */
  toolCallsOutsideParsedRoots: number;
}

export interface IngestPlan {
  emits: ReturnType<typeof mergeToolCall>[];
  stats: IngestStats;
}

/**
 * Read the three JSONLs and build idempotent MERGE cypher statements.
 * Caller either prints them (dry-run) or executes against Neo4j (live mode).
 *
 * Every write is a MERGE, so re-running over the same JSONL is a no-op.
 */
export const planIngest = (opts: IngestOptions): IngestPlan => {
  const { router, lineage, decisions } = readCursordiffJsonls(opts.dataDir);

  // Index router rows by session_id for model attribution fallback.
  const routerBySession = new Map<string, RouterRow>();
  for (const r of router) {
    if (r.session_id) routerBySession.set(r.session_id, r);
  }

  const emits: ReturnType<typeof mergeToolCall>[] = [];
  const seenToolCalls = new Set<string>();
  const seenHunks = new Set<string>();
  const seenTouched = new Set<string>();
  let outsideParsedRootsCount = 0;

  for (const row of lineage) {
    const routerRow = routerBySession.get(row.session_id);
    const { projectId, outsideParsedRoots } = projectIdFor(routerRow?.cwd, opts.parsedRoots, opts.registeredProjectIds);
    if (!seenToolCalls.has(row.tool_call_id)) {
      emits.push({
        ...mergeToolCall(row, projectId, outsideParsedRoots, routerBySession),
        comment: `ToolCall ${row.tool_call_id} (source=cursordiff${outsideParsedRoots ? ', outside parsed roots' : ''})`,
      });
      seenToolCalls.add(row.tool_call_id);
      if (outsideParsedRoots) outsideParsedRootsCount++;
    }

    if (!seenHunks.has(row.hunk_id)) {
      emits.push({
        ...mergeHunk(row, projectId),
        comment: `Hunk ${row.hunk_id} on ${row.path}`,
      });
      seenHunks.add(row.hunk_id);
    }

    emits.push({
      ...mergeProduced(row),
      comment: `PRODUCED: ${row.tool_call_id} → ${row.hunk_id}`,
    });

    // One TOUCHED edge per unique (ToolCall, SourceFile) pair. The Cypher is a
    // no-op when the SourceFile node doesn't exist (file outside a parsed
    // project), so a ToolCall outside every parsed root is handled transparently.
    const touchedKey = `${row.tool_call_id}|${row.path}`;
    if (!seenTouched.has(touchedKey)) {
      emits.push({
        ...mergeTouched(row.tool_call_id, row.path, projectId),
        comment: `TOUCHED: ${row.tool_call_id} → ${row.path}`,
      });
      seenTouched.add(touchedKey);
    }
  }

  // Decisions can reference hunks we haven't seen yet (shouldn't happen in
  // practice — lineage writes before decisions — but tolerate gracefully).
  for (const row of decisions) {
    const lin = lineage.find((l) => l.hunk_id === row.hunk_id);
    const routerRow = lin ? routerBySession.get(lin.session_id) : undefined;
    const { projectId } = projectIdFor(routerRow?.cwd, opts.parsedRoots, opts.registeredProjectIds);
    emits.push({
      ...mergeDecision(row, projectId),
      comment: `Decision ${row.outcome} (byUser=${row.byUser}) on ${row.hunk_id}`,
    });
  }

  return {
    emits,
    stats: {
      routerRows: router.length,
      lineageRows: lineage.length,
      decisionRows: decisions.length,
      toolCalls: seenToolCalls.size,
      hunks: seenHunks.size,
      decisions: decisions.length,
      toolCallsOutsideParsedRoots: outsideParsedRootsCount,
    },
  };
};
