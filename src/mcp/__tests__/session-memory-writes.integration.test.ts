import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { recoverSessionEdges } from '../handlers/session-edge-recovery.helpers.js';
import { CREATE_SESSION_NOTE_QUERY } from '../tools/session-save.tool.js';
import {
  DROP_ABOUT_EDGES_QUERY,
  RECREATE_NOTE_ABOUT_EDGES_QUERY,
  UPDATE_NOTE_QUERY,
} from '../tools/session-update.tool.js';

// Opt in with CGC_NEO4J_WRITE_TESTS=1 against a local Neo4j. These tests WRITE, so they touch only
// project ids that start with proj_cgctest_ and delete everything under that prefix afterwards.
const TEST_PREFIX = 'proj_cgctest_';
const CODEBASE_ID = `${TEST_PREFIX}code`;
const COLLECTION_ID = `${TEST_PREFIX}notes`;
const NODE_ID = `${CODEBASE_ID}:function-one`;

describe.skipIf(process.env.CGC_NEO4J_WRITE_TESTS !== '1')('session memory writes in Neo4j', () => {
  let db: Neo4jService;
  let root: string;
  let filePath: string;
  let anchors: {
    nodeRefs: { id: string; projectId: string }[];
    sourceFileRefs: { projectId: string; filePath: string }[];
  };
  const noteId = 'note_cgctest_1';

  const countAboutEdges = async (): Promise<number> => {
    const rows = await db.run(`MATCH (:SessionNote {id: $noteId})-[r:ABOUT]->() RETURN count(r) AS edges`, { noteId });
    return Number(rows[0].edges);
  };

  const createCodeNodes = () =>
    db.run(
      `MERGE (f:GraphNode:SourceFile {id: $fileId})
         SET f.projectId = $projectId, f.filePath = $filePath, f.name = 'one.ts'
       MERGE (fn:GraphNode:Function {id: $nodeId})
         SET fn.projectId = $projectId, fn.name = 'functionOne', fn.filePath = $filePath`,
      { fileId: `${CODEBASE_ID}:file-one`, nodeId: NODE_ID, projectId: CODEBASE_ID, filePath },
    );

  const deleteCodeNodes = () =>
    db.run(`MATCH (n:GraphNode {projectId: $projectId}) DETACH DELETE n`, { projectId: CODEBASE_ID });

  const deleteEverythingUnderPrefix = () =>
    db.run(`MATCH (n) WHERE n.projectId STARTS WITH $prefix DETACH DELETE n`, { prefix: TEST_PREFIX });

  beforeAll(async () => {
    db = new Neo4jService();
    root = await mkdtemp(join(tmpdir(), 'cgctest-'));
    filePath = join(root, 'one.ts');
    anchors = {
      nodeRefs: [{ id: NODE_ID, projectId: CODEBASE_ID }],
      sourceFileRefs: [{ projectId: CODEBASE_ID, filePath }],
    };
    await deleteEverythingUnderPrefix();
    await db.run(
      `MERGE (c:Project {projectId: $codebaseId}) SET c.name = 'cgctest code', c.kind = 'codebase', c.path = $root
       MERGE (n:Project {projectId: $collectionId}) SET n.name = 'cgctest notes', n.kind = 'collection', n.description = 'throwaway'`,
      { codebaseId: CODEBASE_ID, collectionId: COLLECTION_ID, root },
    );
    await createCodeNodes();
  });

  afterAll(async () => {
    try {
      await deleteEverythingUnderPrefix();
      const remaining = await db.run(`MATCH (n) WHERE n.projectId STARTS WITH $prefix RETURN count(n) AS remaining`, {
        prefix: TEST_PREFIX,
      });
      expect(Number(remaining[0].remaining)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await db.close();
    }
  });

  it('saves a note anchored to a code node and a file with one :ABOUT edge each', async () => {
    const rows = await db.run(CREATE_SESSION_NOTE_QUERY, {
      noteId,
      projectId: COLLECTION_ID,
      sessionId: 'cgctest-session',
      agentId: 'cgctest-agent',
      topic: 'throwaway topic',
      content: 'throwaway content for the write test',
      category: 'insight',
      severity: 'info',
      aboutNodeIds: [NODE_ID],
      aboutPaths: [filePath],
      aboutPathHashes: ['hash-one'],
      ...anchors,
      supersededBy: null,
      supersedes: [],
      expiresAt: null,
    });

    expect(rows[0].noteId).toBe(noteId);
    expect(await countAboutEdges()).toBe(2);
  });

  it('updates the note and rebuilds the same two :ABOUT edges', async () => {
    const updated = await db.run(UPDATE_NOTE_QUERY, {
      projectId: COLLECTION_ID,
      noteId,
      topic: 'updated topic',
      content: null,
      category: null,
      severity: 'warning',
      aboutNodeIds: [NODE_ID],
      aboutPaths: [filePath],
      aboutPathHashes: ['hash-two'],
      supersededBy: null,
      supersededByProvided: false,
    });
    const dropped = await db.run(DROP_ABOUT_EDGES_QUERY, { projectId: COLLECTION_ID, noteId });
    const created = await db.run(RECREATE_NOTE_ABOUT_EDGES_QUERY, { projectId: COLLECTION_ID, noteId, ...anchors });

    expect(updated[0]).toMatchObject({ topic: 'updated topic', severity: 'warning' });
    expect(Number(dropped[0].dropped)).toBe(2);
    expect(Number(created[0].created)).toBe(2);
    expect(await countAboutEdges()).toBe(2);
  });

  it('loses both edges when the code is deleted, then recovery relinks both from the stored anchors', async () => {
    await deleteCodeNodes();
    expect(await countAboutEdges()).toBe(0);

    const whileDeleted = await recoverSessionEdges(db, CODEBASE_ID);
    expect(whileDeleted).toMatchObject({ aboutEdges: 0, staleAboutRefs: 1 });
    expect(await countAboutEdges()).toBe(0);

    await createCodeNodes();
    const afterReparse = await recoverSessionEdges(db, CODEBASE_ID);
    expect(afterReparse).toMatchObject({ aboutEdges: 2, staleAboutRefs: 0 });
    expect(await countAboutEdges()).toBe(2);

    const again = await recoverSessionEdges(db, CODEBASE_ID);
    expect(again.aboutEdges).toBe(2);
    expect(await countAboutEdges()).toBe(2);
  });
});
