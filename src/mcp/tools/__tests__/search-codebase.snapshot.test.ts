/**
 * Snapshot test — searchCodeRaw extraction regression guard (0009)
 *
 * Purpose: lock the response shape and top-K ordering of `searchCodeRaw` so
 * that future edits to the helper (e.g. Cypher changes from 0013) cannot
 * silently change `search_codebase` behavior.
 *
 * Strategy: recorded fixtures (canned Neo4j responses). No live Neo4j
 * connection is required — the Neo4jService is mocked at the module level.
 * This keeps the test fast and CI-safe without an external dependency.
 *
 * Fixtures represent realistic VECTOR_SEARCH_MULTI rows (as neo4j-driver
 * would return them after record.toObject()) for three representative query
 * scenarios: high-relevance match, mixed-relevance, and below-threshold.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { searchCodeRaw, projectCodeResult } from '../../handlers/query-signals.handler.js';
import type { SearchCodeRawRow } from '../../handlers/query-signals.handler.js';

// ---------------------------------------------------------------------------
// Fixtures — canned Neo4j rows (realistic shape from neo4j.service.ts)
// ---------------------------------------------------------------------------

const makeNode = (
  id: string,
  name: string,
  filePath: string,
  score: number,
  projectId = 'proj_test',
): SearchCodeRawRow => ({
  node: {
    id,
    labels: ['Function'],
    properties: {
      id,
      name,
      filePath,
      sourceCode: `function ${name}() { /* impl */ }`,
      projectId,
    },
  },
  score,
  projectId,
});

/** Fixture A — three nodes above threshold, ordered DESC by score */
const FIXTURE_HIGH_RELEVANCE: SearchCodeRawRow[] = [
  makeNode('node-001', 'verifyWebhookSignature', 'src/webhooks/verify.ts', 0.91),
  makeNode('node-002', 'validateHmac', 'src/utils/hmac.ts', 0.82),
  makeNode('node-003', 'parseWebhookPayload', 'src/webhooks/parse.ts', 0.74),
];

/** Fixture B — mixed: two above threshold (0.5), one below */
const FIXTURE_MIXED_RELEVANCE: SearchCodeRawRow[] = [
  makeNode('node-004', 'createWebhookHandler', 'src/webhooks/handler.ts', 0.68),
  makeNode('node-005', 'getSecret', 'src/config/secrets.ts', 0.55),
  makeNode('node-006', 'formatDate', 'src/utils/date.ts', 0.28), // below threshold — filtered
];

/** Fixture C — empty (below-threshold query) */
const FIXTURE_NO_MATCH: SearchCodeRawRow[] = [];

/** Fixture D — multi-project results */
const FIXTURE_MULTI_PROJECT: SearchCodeRawRow[] = [
  makeNode('node-007', 'signRequest', 'src/auth/sign.ts', 0.88, 'proj_aaa'),
  makeNode('node-008', 'verifyRequest', 'src/auth/verify.ts', 0.79, 'proj_bbb'),
  makeNode('node-009', 'getPublicKey', 'src/auth/keys.ts', 0.71, 'proj_aaa'),
];

// ---------------------------------------------------------------------------
// Mock Neo4jService
// ---------------------------------------------------------------------------

const mockRun = vi.fn();

vi.mock('../../../storage/neo4j/neo4j.service.js', () => ({
  Neo4jService: vi.fn(() => ({ run: mockRun })),
  QUERIES: {},
}));

const makeMockNeo4j = () =>
  ({ run: mockRun }) as unknown as import('../../../storage/neo4j/neo4j.service.js').Neo4jService;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('searchCodeRaw — shape and ordering snapshot (0009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rows sorted DESC by score, filtered by minSimilarity', async () => {
    mockRun.mockResolvedValueOnce(FIXTURE_HIGH_RELEVANCE);
    const rows = await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_test'],
      embedding: [0.1, 0.2, 0.3],
      limit: 5,
      minSimilarity: 0.5,
    });

    expect(rows).toHaveLength(3);
    // Ordering preserved from fixture (DESC by score)
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[1].score).toBeGreaterThan(rows[2].score);
    // Every row meets the threshold
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
    // Shape snapshot
    expect(rows[0]).toMatchSnapshot('high-relevance-row-0');
  });

  it('filters out rows below minSimilarity threshold', async () => {
    mockRun.mockResolvedValueOnce(FIXTURE_MIXED_RELEVANCE);
    const rows = await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_test'],
      embedding: [0.1, 0.2, 0.3],
      limit: 5,
      minSimilarity: 0.5,
    });

    expect(rows).toHaveLength(2); // node-006 (score 0.28) filtered out
    expect(rows.every((r) => r.score >= 0.5)).toBe(true);
    expect(rows.map((r) => r.node.properties.id)).toEqual(['node-004', 'node-005']);
  });

  it('returns empty array when no results above threshold', async () => {
    mockRun.mockResolvedValueOnce(FIXTURE_NO_MATCH);
    const rows = await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_test'],
      embedding: [0.1, 0.2, 0.3],
      limit: 5,
      minSimilarity: 0.5,
    });

    expect(rows).toHaveLength(0);
    expect(rows).toMatchSnapshot('empty-result');
  });

  it('passes projectIds as array to Neo4j query (not scalar)', async () => {
    mockRun.mockResolvedValueOnce([]);
    await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_aaa', 'proj_bbb'],
      embedding: [0.1, 0.2],
      limit: 3,
      minSimilarity: 0.5,
    });

    const [, params] = mockRun.mock.calls[0];
    expect(Array.isArray(params.projectIds)).toBe(true);
    expect(params.projectIds).toEqual(['proj_aaa', 'proj_bbb']);
    // Single-string projectId must NOT be passed (0013 migration guard)
    expect(params).not.toHaveProperty('projectId');
  });

  it('each result row carries a projectId field (0013 multi-project)', async () => {
    mockRun.mockResolvedValueOnce(FIXTURE_MULTI_PROJECT);
    const rows = await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_aaa', 'proj_bbb'],
      embedding: [0.1, 0.2, 0.3],
      limit: 5,
      minSimilarity: 0.5,
    });

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(typeof r.projectId).toBe('string');
      expect(['proj_aaa', 'proj_bbb']).toContain(r.projectId);
    }
    // Shape snapshot — confirms projectId is present at the row level
    expect(rows).toMatchSnapshot('multi-project-rows');
  });

  it('uses fetchMultiplier default of 10 when not provided', async () => {
    mockRun.mockResolvedValueOnce([]);
    await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_test'],
      embedding: [0.1],
      limit: 3,
      minSimilarity: 0.5,
    });

    const [, params] = mockRun.mock.calls[0];
    expect(params.fetchMultiplier).toBe(10);
  });

  it('respects custom fetchMultiplier', async () => {
    mockRun.mockResolvedValueOnce([]);
    await searchCodeRaw(makeMockNeo4j(), {
      projectIds: ['proj_test'],
      embedding: [0.1],
      limit: 3,
      minSimilarity: 0.5,
      fetchMultiplier: 5,
    });

    const [, params] = mockRun.mock.calls[0];
    expect(params.fetchMultiplier).toBe(5);
  });
});

describe('projectCodeResult — shape snapshot (0009)', () => {
  it('projects a SearchCodeRawRow to the public query_signals code result shape', () => {
    const row = FIXTURE_HIGH_RELEVANCE[0];
    const result = projectCodeResult(row);

    expect(result).toMatchObject({
      type: 'Function',
      id: 'node-001',
      name: 'verifyWebhookSignature',
      filePath: 'src/webhooks/verify.ts',
      score: 0.91,
      projectId: 'proj_test',
    });
    expect(typeof result.snippet).toBe('string');
    expect(result).toMatchSnapshot('projected-code-result');
  });

  it('truncates sourceCode to snippetLength', () => {
    const longSource = 'x'.repeat(1000);
    const row: SearchCodeRawRow = {
      node: {
        id: 'long-node',
        labels: ['Class'],
        properties: { id: 'long-node', name: 'BigClass', filePath: 'src/big.ts', sourceCode: longSource },
      },
      score: 0.75,
      projectId: 'proj_test',
    };
    const result = projectCodeResult(row, 300);
    expect(result.snippet).toHaveLength(300 + 3); // 300 chars + '...'
    expect(result.snippet?.endsWith('...')).toBe(true);
  });

  it('returns null snippet when sourceCode is absent', () => {
    const row: SearchCodeRawRow = {
      node: { id: 'bare', labels: ['Function'], properties: { id: 'bare', name: 'bare', filePath: 'src/bare.ts' } },
      score: 0.6,
      projectId: 'proj_test',
    };
    const result = projectCodeResult(row);
    expect(result.snippet).toBeNull();
  });

  it('rounds score to 3 decimal places', () => {
    const row: SearchCodeRawRow = {
      node: { id: 'n', labels: ['Function'], properties: { id: 'n' } },
      score: 0.91234567,
      projectId: 'proj_test',
    };
    const result = projectCodeResult(row);
    expect(result.score).toBe(0.912);
  });
});
