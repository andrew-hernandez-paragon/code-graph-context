import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { ANCHORED_NOTES_QUERY } from '../handlers/anchored-notes.js';
import { CODE_NOTE_CANDIDATES_QUERY, NOTE_ROWS_QUERY, VECTOR_NOTE_CANDIDATES_QUERY } from '../handlers/note-search.js';
import {
  FILTER_SEARCH_NOTES_QUERY,
  FIND_BOOKMARK_QUERY,
  VECTOR_SEARCH_BOOKMARKS_QUERY,
} from '../tools/session-recall.tool.js';
import { CREATE_BOOKMARK_QUERY, CREATE_SESSION_NOTE_QUERY } from '../tools/session-save.tool.js';
import { RECREATE_NOTE_ABOUT_EDGES_QUERY } from '../tools/session-update.tool.js';

// Opt in against a local Neo4j whose vector indexes carry the projectId filter.
// Every statement runs in a READ transaction: queries that write are only planned with EXPLAIN.
describe.skipIf(process.env.CGC_NEO4J_TESTS !== '1')('session memory queries in Neo4j', () => {
  let db: Neo4jService;
  let read: Pick<Neo4jService, 'run'>;
  let noteProjects: string[];
  let noteEmbedding: number[];
  let bookmarkProject: string;
  let bookmarkEmbedding: number[];

  beforeAll(async () => {
    db = new Neo4jService();
    read = {
      run: async (query, params = {}) => {
        const session = db.getDriver().session({ defaultAccessMode: 'READ' });
        try {
          const result = await session.executeRead((tx) => tx.run(query, params), { timeout: 30000 });
          return result.records.map((record) => record.toObject());
        } finally {
          await session.close();
        }
      },
    };
    const projects = await read.run(
      `MATCH (n:SessionNote) WHERE n.embedding IS NOT NULL
       WITH n.projectId AS projectId, count(*) AS notes ORDER BY notes ASC
       RETURN projectId LIMIT 2`,
    );
    noteProjects = projects.map((row) => row.projectId);
    [{ embedding: noteEmbedding }] = await read.run(
      `MATCH (n:SessionNote {projectId: $projectId}) WHERE n.embedding IS NOT NULL RETURN n.embedding AS embedding LIMIT 1`,
      { projectId: noteProjects[0] },
    );
    [{ projectId: bookmarkProject, embedding: bookmarkEmbedding }] = await read.run(
      `MATCH (b:SessionBookmark) WHERE b.embedding IS NOT NULL
       RETURN b.projectId AS projectId, b.embedding AS embedding LIMIT 1`,
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  const searchParams = (projectIds: string[]) => ({
    projectIds,
    queryEmbedding: noteEmbedding,
    limit: 50,
    pool: 50,
    category: null,
    severity: null,
    sessionId: null,
    agentId: null,
    sinceMs: null,
    includeSuperseded: true,
  });

  const searchNotes = async (projectIds: string[]) => {
    const candidates = await read.run(VECTOR_NOTE_CANDIDATES_QUERY, searchParams(projectIds));
    const rows = await read.run(NOTE_ROWS_QUERY, { ids: candidates.map((row) => row.id) });
    const scores = new Map(candidates.map((row) => [row.id, row.score]));
    return rows
      .map((row) => ({
        id: row.id as string,
        projectId: row.projectId as string,
        relevance: Number(scores.get(row.id)),
      }))
      .sort((a, b) => b.relevance - a.relevance);
  };

  it('semantic note search returns notes from the requested projects only', async () => {
    const oneProject = await searchNotes([noteProjects[0]]);
    expect(oneProject.length).toBeGreaterThan(0);
    expect(new Set(oneProject.map((row) => row.projectId))).toEqual(new Set([noteProjects[0]]));

    const both = await searchNotes(noteProjects);
    expect(new Set(both.map((row) => row.projectId))).toEqual(new Set(noteProjects));
    expect(both[0].relevance).toBeGreaterThan(0.99);
  });

  it('finds notes anchored to the files a code search matched, ranked by file', async () => {
    const [anchored] = await read.run(
      `MATCH (n:SessionNote)-[:ABOUT]->(t) WHERE t.filePath IS NOT NULL AND n.supersededBy IS NULL
       RETURN n.id AS id, n.projectId AS projectId, t.filePath AS filePath, t.id AS nodeId LIMIT 1`,
    );
    const rows = await read.run(CODE_NOTE_CANDIDATES_QUERY, {
      ...searchParams([anchored.projectId]),
      files: ['/no/such/file.ts', anchored.filePath],
    });
    expect(rows.map((row) => row.id)).toContain(anchored.id);
    expect(rows.every((row) => Number(row.rank) === 1)).toBe(true);

    const notes = await read.run(ANCHORED_NOTES_QUERY, { nodeIds: [anchored.nodeId], files: [] });
    expect(notes.map((row) => row.id)).toContain(anchored.id);
  });

  it('filter mode returns notes from the requested projects with their anchors', async () => {
    const rows = await read.run(FILTER_SEARCH_NOTES_QUERY, { ...searchParams(noteProjects), limit: 100 });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set(noteProjects));
    for (const row of rows) {
      expect(Array.isArray(row.aboutPaths)).toBe(true);
      expect(row.aboutPathHashes).toHaveLength(row.aboutPaths.length);
    }
  });

  it('bookmark search by session and by meaning stays within the requested projects', async () => {
    const [latest] = await read.run(FIND_BOOKMARK_QUERY, {
      projectIds: [bookmarkProject],
      sessionId: null,
      agentId: null,
    });
    expect(latest.projectId).toBe(bookmarkProject);
    expect(latest.workingSetPaths).toEqual([]);

    const [match] = await read.run(VECTOR_SEARCH_BOOKMARKS_QUERY, {
      projectIds: [bookmarkProject],
      queryEmbedding: bookmarkEmbedding,
      minSimilarity: 0,
      agentId: null,
    });
    expect(match.projectId).toBe(bookmarkProject);
    expect(match.relevance).toBeGreaterThan(0.99);

    expect(
      await read.run(VECTOR_SEARCH_BOOKMARKS_QUERY, {
        projectIds: ['proj_no_such_project'],
        queryEmbedding: bookmarkEmbedding,
        minSimilarity: 0,
        agentId: null,
      }),
    ).toEqual([]);
  });

  it('counts stale anchors by id prefix', async () => {
    const [row] = await read.run(QUERIES.COUNT_STALE_ABOUT_REFS, {
      projectId: noteProjects[0],
      projectIdPrefix: `${noteProjects[0]}:`,
    });
    expect(typeof row.staleCount.toNumber()).toBe('number');
  });

  it.each([
    ['session_save note', CREATE_SESSION_NOTE_QUERY],
    ['session_save bookmark', CREATE_BOOKMARK_QUERY],
    ['session_update edges', RECREATE_NOTE_ABOUT_EDGES_QUERY],
    ['recreate ABOUT by id', QUERIES.RECREATE_ABOUT_EDGES],
    ['recreate ABOUT by path', QUERIES.RECREATE_ABOUT_PATH_EDGES],
    ['recreate REFERENCES by id', QUERIES.RECREATE_REFERENCES_EDGES],
    ['recreate REFERENCES by path', QUERIES.RECREATE_REFERENCES_PATH_EDGES],
  ])('plans the %s statement without writing', async (_name, query) => {
    await expect(read.run(`EXPLAIN ${query}`, {})).resolves.toEqual([]);
  });
});
