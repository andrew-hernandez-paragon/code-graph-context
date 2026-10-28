import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectDeletionService, ProjectService } from '../../core/projects/index.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { MOVE_NOTE_QUERY } from '../tools/session-update.tool.js';

// Opt in with CGC_NEO4J_WRITE_TESTS=1 against a local Neo4j. These tests WRITE, so they touch only
// project ids that start with proj_cgctest_delete_ and delete everything under that prefix afterwards.
const TEST_PREFIX = 'proj_cgctest_delete_';
const OLD_ID = `${TEST_PREFIX}old`;
const TARGET_ID = `${TEST_PREFIX}target`;
const KEPT_ID = `${TEST_PREFIX}kept`;
const NODE_ID = `${OLD_ID}:function-one`;
const KEPT_NODE_ID = `${KEPT_ID}:function-two`;
const DELIBERATION_PREFIX = 'delib_cgctest_delete_';

describe.skipIf(process.env.CGC_NEO4J_WRITE_TESTS !== '1')('project deletion in Neo4j', () => {
  let db: Neo4jService;
  let deletion: ProjectDeletionService;

  const countUnder = async (projectId: string): Promise<number> => {
    const rows = await db.run(`MATCH (n {projectId: $projectId}) RETURN count(n) AS count`, { projectId });
    return Number(rows[0].count);
  };

  const cleanUp = async () => {
    await db.run(`MATCH (n) WHERE n.projectId STARTS WITH $prefix DETACH DELETE n`, { prefix: TEST_PREFIX });
    await db.run(`MATCH (d:Deliberation) WHERE d.id STARTS WITH $prefix DETACH DELETE d`, {
      prefix: DELIBERATION_PREFIX,
    });
  };

  beforeAll(async () => {
    db = new Neo4jService();
    deletion = new ProjectDeletionService(new ProjectService(db), db);
    await cleanUp();
    await db.run(
      `MERGE (old:Project {projectId: $oldId}) SET old.name = 'cgctest old', old.kind = 'codebase', old.path = '/cgctest/old', old.status = 'complete'
       MERGE (target:Project {projectId: $targetId}) SET target.name = 'cgctest target', target.kind = 'collection', target.description = 'throwaway'
       MERGE (kept:Project {projectId: $keptId}) SET kept.name = 'cgctest kept', kept.kind = 'collection', kept.description = 'throwaway'
       CREATE (fn:GraphNode:Function {id: $nodeId, projectId: $oldId, name: 'functionOne'})
       CREATE (note:SessionNote {id: 'note_cgctest_delete_1', projectId: $oldId, topic: 'throwaway', content: 'throwaway note content',
         aboutNodeIds: [$nodeId, $keptNodeId], aboutPaths: ['/cgctest/old/one.ts'], aboutPathHashes: ['hash']})
       CREATE (note)-[:ABOUT]->(fn)
       CREATE (:SessionNoteChunk {id: 'chunk_cgctest_delete_1', projectId: $oldId, parentNoteId: 'note_cgctest_delete_1', content: 'chunk'})
       CREATE (:SessionBookmark {id: 'bookmark_cgctest_1', projectId: $oldId, summary: 'throwaway',
         workingSetNodeIds: [$nodeId, $keptNodeId], workingSetPaths: ['/cgctest/old']})
       CREATE (:SwarmTask {id: 'task_cgctest_delete_1', projectId: $oldId, title: 'throwaway'})
       CREATE (:Pheromone {id: 'pheromone_cgctest_delete_1', projectId: $oldId, type: 'warning'})
       CREATE (d1:Deliberation {id: $deliberationOne, projectIds: [$oldId, $keptId]})
       CREATE (d1)-[:SCOPED_TO]->(old)
       CREATE (d2:Deliberation {id: $deliberationTwo, projectIds: [$oldId, $targetId]})
       CREATE (d2)-[:SCOPED_TO]->(old)`,
      {
        oldId: OLD_ID,
        targetId: TARGET_ID,
        keptId: KEPT_ID,
        nodeId: NODE_ID,
        keptNodeId: KEPT_NODE_ID,
        deliberationOne: `${DELIBERATION_PREFIX}1`,
        deliberationTwo: `${DELIBERATION_PREFIX}2`,
      },
    );
  });

  afterAll(async () => {
    try {
      await cleanUp();
      const remaining = await db.run(`MATCH (n) WHERE n.projectId STARTS WITH $prefix RETURN count(n) AS remaining`, {
        prefix: TEST_PREFIX,
      });
      expect(Number(remaining[0].remaining)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('moves a single note and its chunk to another project and keeps its anchors', async () => {
    const moved = await db.run(MOVE_NOTE_QUERY, {
      projectId: OLD_ID,
      noteId: 'note_cgctest_delete_1',
      targetProjectId: TARGET_ID,
    });
    expect(Number(moved[0].chunks)).toBe(1);

    const [note] = await db.run(
      `MATCH (n:SessionNote {id: 'note_cgctest_delete_1'})
       RETURN n.projectId AS projectId, n.aboutNodeIds AS aboutNodeIds, n.aboutPaths AS aboutPaths,
              size([(n)-[:ABOUT]->(t) | t]) AS aboutEdges`,
    );
    expect(note).toMatchObject({
      projectId: TARGET_ID,
      aboutNodeIds: [NODE_ID, KEPT_NODE_ID],
      aboutPaths: ['/cgctest/old/one.ts'],
    });
    expect(Number(note.aboutEdges)).toBe(1);
    const [chunk] = await db.run(
      `MATCH (c:SessionNoteChunk {id: 'chunk_cgctest_delete_1'}) RETURN c.projectId AS projectId`,
    );
    expect(chunk.projectId).toBe(TARGET_ID);

    await db.run(MOVE_NOTE_QUERY, { projectId: TARGET_ID, noteId: 'note_cgctest_delete_1', targetProjectId: OLD_ID });
    expect(await countUnder(OLD_ID)).toBe(7);
  });

  it('refuses without a memory flag and a dry run changes nothing', async () => {
    await expect(deletion.planDeletion(OLD_ID, {})).rejects.toThrow('--move-memory-to');

    const plan = await deletion.planDeletion(OLD_ID, { moveMemoryTo: TARGET_ID });

    expect(plan.moved).toEqual({ SessionNote: 1, SessionNoteChunk: 1, SessionBookmark: 1 });
    expect(plan.deleted).toEqual({ 'Function:GraphNode': 1, SwarmTask: 1, Pheromone: 1, Project: 1 });
    expect(plan.deliberations).toBe(2);
    expect(plan.prunedAnchors).toEqual({ aboutNodeIds: 1, workingSetNodeIds: 1 });
    expect(await countUnder(OLD_ID)).toBe(7);
    expect(await countUnder(TARGET_ID)).toBe(1);
  });

  it('moves the memory with pruned anchors, re-scopes deliberations and leaves nothing under the deleted id', async () => {
    const plan = await deletion.planDeletion(OLD_ID, { moveMemoryTo: TARGET_ID });

    await deletion.executeDeletion(plan);

    expect(await countUnder(OLD_ID)).toBe(0);
    const [note] = await db.run(
      `MATCH (n:SessionNote {id: 'note_cgctest_delete_1'})
       RETURN n.projectId AS projectId, n.aboutNodeIds AS aboutNodeIds, n.aboutPaths AS aboutPaths`,
    );
    expect(note).toEqual({ projectId: TARGET_ID, aboutNodeIds: [KEPT_NODE_ID], aboutPaths: ['/cgctest/old/one.ts'] });
    const [bookmark] = await db.run(
      `MATCH (b:SessionBookmark {id: 'bookmark_cgctest_1'})
       RETURN b.projectId AS projectId, b.workingSetNodeIds AS workingSetNodeIds, b.workingSetPaths AS workingSetPaths`,
    );
    expect(bookmark).toEqual({
      projectId: TARGET_ID,
      workingSetNodeIds: [KEPT_NODE_ID],
      workingSetPaths: ['/cgctest/old'],
    });
    const [chunk] = await db.run(
      `MATCH (c:SessionNoteChunk {id: 'chunk_cgctest_delete_1'}) RETURN c.projectId AS projectId`,
    );
    expect(chunk.projectId).toBe(TARGET_ID);

    const deliberations = await db.run(
      `MATCH (d:Deliberation) WHERE d.id STARTS WITH $prefix
       RETURN d.id AS id, d.projectIds AS projectIds, [(d)-[:SCOPED_TO]->(p:Project) | p.projectId] AS scopedTo
       ORDER BY d.id`,
      { prefix: DELIBERATION_PREFIX },
    );
    expect(deliberations).toEqual([
      { id: 'delib_cgctest_delete_1', projectIds: [TARGET_ID, KEPT_ID], scopedTo: [TARGET_ID] },
      { id: 'delib_cgctest_delete_2', projectIds: [TARGET_ID], scopedTo: [TARGET_ID] },
    ]);

    const leftovers = await db.run(
      `MATCH (n) WHERE n.id STARTS WITH 'task_cgctest_delete' OR n.id STARTS WITH 'pheromone_cgctest_delete' OR n.projectId = $oldId RETURN count(n) AS count`,
      {
        oldId: OLD_ID,
      },
    );
    expect(Number(leftovers[0].count)).toBe(0);
    expect(await new ProjectService(db).findById(OLD_ID)).toBeNull();
  });
});
