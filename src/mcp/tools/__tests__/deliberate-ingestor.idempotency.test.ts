/**
 * Deliberate ingestor idempotency test (proposal 0004)
 *
 * Strategy: recorded fixture deliberation.jsonl (in-memory). planIngestDeliberate
 * is called twice over the same fixture. Because every write is a MERGE, the
 * second call should produce the SAME set of cypher statements — no duplicates.
 * No live Neo4j connection is required.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { planIngestDeliberate } from '../../../ingestors/deliberate/index.js';

// ---------------------------------------------------------------------------
// Fixture — minimal deliberation.jsonl covering all three event types
// ---------------------------------------------------------------------------

const DELIBERATION_EVENT = JSON.stringify({
  type: 'deliberation-start',
  id: 'del_test001',
  topic: 'Should we adopt the new caching strategy?',
  projectIds: ['proj_c5449d91539b'],
  mode: 'one-shot',
  status: 'in-progress',
  aboutNodeIds: [],
  triggeredBy: 'test-agent',
  sessionId: 'sess_test',
  ts: 1747000000000,
});

const POSITION_PRAGMATIST = JSON.stringify({
  type: 'position-complete',
  id: 'pos_test001',
  deliberationId: 'del_test001',
  role: 'pragmatist',
  content: 'The simplest approach is to use Redis with a 5-minute TTL.',
  claims: ['Low implementation cost', 'Team already knows Redis'],
  evidence: ['Existing Redis usage in the codebase'],
  counterArgs: ['TTL may be too short for some use cases'],
  status: 'asserted',
  agentId: 'agent-pragmatist',
  ts: 1747000001000,
});

const POSITION_PERFECTIONIST = JSON.stringify({
  type: 'position-complete',
  id: 'pos_test002',
  deliberationId: 'del_test001',
  role: 'perfectionist',
  content: 'We should implement a proper cache invalidation strategy instead of TTL.',
  claims: ['TTL-based caches produce stale data', 'Event-driven invalidation is more correct'],
  evidence: [],
  counterArgs: ['Higher implementation complexity'],
  status: 'asserted',
  agentId: 'agent-perfectionist',
  ts: 1747000002000,
});

const POSITION_OPERATIONS = JSON.stringify({
  type: 'position-complete',
  id: 'pos_test003',
  deliberationId: 'del_test001',
  role: 'operations',
  content: 'ABSTAIN-NO-UNIQUE-POSITION',
  claims: [],
  evidence: [],
  counterArgs: [],
  status: 'abstained',
  agentId: 'agent-operations',
  ts: 1747000003000,
});

const VERDICT_EVENT = JSON.stringify({
  type: 'verdict',
  id: 'vd_test001',
  deliberationId: 'del_test001',
  verdict: 'ITERATE',
  rationale: 'Panel split: pragmatist favors simplicity, perfectionist favors correctness. Recommend iterating with a hybrid approach.',
  agentId: 'agent-synthesizer',
  ts: 1747000004000,
});

const FIXTURE_LINES = [
  DELIBERATION_EVENT,
  POSITION_PRAGMATIST,
  POSITION_PERFECTIONIST,
  POSITION_OPERATIONS,
  VERDICT_EVENT,
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFixtureDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'deliberate-test-'));
  writeFileSync(join(dir, 'deliberation.jsonl'), FIXTURE_LINES, 'utf-8');
  return dir;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deliberate ingestor idempotency', () => {
  it('produces identical cypher plans on two successive calls over the same fixture', () => {
    const dir = makeFixtureDir();
    try {
      const plan1 = planIngestDeliberate({ dataDir: dir });
      const plan2 = planIngestDeliberate({ dataDir: dir });

      // Same number of statements
      expect(plan2.emits.length).toBe(plan1.emits.length);

      // Same queries (order-stable since same input)
      const queries1 = plan1.emits.map((e) => e.query);
      const queries2 = plan2.emits.map((e) => e.query);
      expect(queries2).toEqual(queries1);

      // Same params
      const params1 = plan1.emits.map((e) => JSON.stringify(e.params));
      const params2 = plan2.emits.map((e) => JSON.stringify(e.params));
      expect(params2).toEqual(params1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts deliberations, positions, verdicts correctly', () => {
    const dir = makeFixtureDir();
    try {
      const { stats } = planIngestDeliberate({ dataDir: dir });
      expect(stats.deliberations).toBe(1);
      expect(stats.positions).toBe(3);
      expect(stats.verdicts).toBe(1);
      expect(stats.eventRows).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits SCOPED_TO edge for each projectId in the deliberation', () => {
    const dir = makeFixtureDir();
    try {
      const { emits, stats } = planIngestDeliberate({ dataDir: dir });
      const scopedToEmits = emits.filter((e) => e.comment?.startsWith('SCOPED_TO'));
      expect(scopedToEmits.length).toBe(1);
      expect(stats.scopedToEdges).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not duplicate nodes or edges when re-ingesting (MERGE semantics verified by query shape)', () => {
    const dir = makeFixtureDir();
    try {
      const { emits } = planIngestDeliberate({ dataDir: dir });

      // All node merge statements use MERGE, not CREATE
      const nodeMerges = emits.filter(
        (e) => e.comment?.startsWith('Deliberation') || e.comment?.startsWith('Position') || e.comment?.startsWith('Verdict'),
      );
      for (const emit of nodeMerges) {
        expect(emit.query.trimStart()).toMatch(/^MERGE/);
      }

      // All edge statements use MERGE as well
      const edgeMerges = emits.filter(
        (e) =>
          e.comment?.startsWith('HAS_POSITION') ||
          e.comment?.startsWith('RESULTED_IN') ||
          e.comment?.startsWith('SCOPED_TO'),
      );
      for (const emit of edgeMerges) {
        expect(emit.query).toContain('MERGE');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles empty deliberation.jsonl gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deliberate-empty-'));
    try {
      writeFileSync(join(dir, 'deliberation.jsonl'), '', 'utf-8');
      const { emits, stats } = planIngestDeliberate({ dataDir: dir });
      expect(emits.length).toBe(0);
      expect(stats.deliberations).toBe(0);
      expect(stats.positions).toBe(0);
      expect(stats.verdicts).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles missing deliberation.jsonl gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deliberate-missing-'));
    try {
      const { emits, stats } = planIngestDeliberate({ dataDir: dir });
      expect(emits.length).toBe(0);
      expect(stats.eventRows).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
