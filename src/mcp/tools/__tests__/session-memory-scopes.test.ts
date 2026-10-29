import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIND_BY_DIRECTORY_NAME_QUERY,
  FIND_BY_ID_QUERY,
  FIND_BY_NAME_QUERY,
  FIND_BY_ROOT_CANDIDATES_QUERY,
  LIST_RECENT_QUERY,
} from '../../../core/projects/project.service.js';
import { createSessionRecallTool } from '../session-recall.tool.js';
import { createSessionSaveTool } from '../session-save.tool.js';
import { MOVE_NOTE_QUERY, createSessionUpdateTool } from '../session-update.tool.js';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../storage/neo4j/neo4j.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../storage/neo4j/neo4j.service.js')>()),
  Neo4jService: class {
    run = run;
    close = vi.fn();
  },
}));
vi.mock('../../../core/embeddings/embeddings.service.js', () => ({
  EmbeddingsService: class {
    provider = 'test';
    model = 'test-model';
    embedText = vi.fn().mockResolvedValue([0.1, 0.2]);
  },
  getEmbeddingDimensions: () => 2,
}));
vi.mock('../../handlers/session-note-chunks.js', () => ({ saveSessionNoteChunks: vi.fn().mockResolvedValue(0) }));
vi.mock('../../../core/utils/file-utils.js', () => ({ debugLog: vi.fn() }));

const SHA256_OF_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const OTHER_PROJECT_NODE = 'proj_other:ClassDeclaration:abc123';
const UNPARSED_NODE = 'proj_gone:Function:def456';

let directory: string;
let storedNote: Record<string, unknown> | null;

const projectRows = () => [
  { projectId: 'proj_code', name: 'code', kind: 'codebase', path: directory },
  { projectId: 'proj_other', name: 'other', kind: 'codebase', path: '/elsewhere/other' },
  { projectId: 'proj_notes', name: 'notes', kind: 'collection', path: null },
];

// Stands in for Neo4j for the statements these tools issue; each branch answers one statement by a distinctive fragment.
const fakeRun = async (query: string, params: Record<string, any>) => {
  if (query === FIND_BY_ID_QUERY) return projectRows().filter((project) => project.projectId === params.projectId);
  if (query === FIND_BY_NAME_QUERY) return projectRows().filter((project) => project.name === params.name);
  if (query === FIND_BY_DIRECTORY_NAME_QUERY) {
    return projectRows().filter((project) => project.path?.endsWith(params.directoryName));
  }
  if (query === FIND_BY_ROOT_CANDIDATES_QUERY) {
    return projectRows().filter(
      (project) => project.path && params.rootCandidates.includes(project.path) && params.kinds.includes(project.kind),
    );
  }
  if (query === LIST_RECENT_QUERY) return projectRows().map((project) => ({ ...project, total: projectRows().length }));
  if (query.includes('AS resolvedIds')) {
    const known = new Set([OTHER_PROJECT_NODE]);
    return [
      { resolvedIds: params.nodeRefs.map((ref: { id: string }) => ref.id).filter((id: string) => known.has(id)) },
    ];
  }
  if (query.includes('CREATE (n:SessionNote')) {
    storedNote = {
      id: params.noteId,
      projectId: params.projectId,
      topic: params.topic,
      aboutNodeIds: params.aboutNodeIds,
      aboutPaths: params.aboutPaths,
      aboutPathHashes: params.aboutPathHashes,
      aboutNodes: [],
    };
    return [{ noteId: params.noteId, markedIds: [], notFoundIds: [] }];
  }
  if (query.includes('CREATE (b:SessionBookmark')) return [{ id: params.bookmarkId, summary: params.summary }];
  if (query.includes('RETURN coalesce(n.aboutNodeIds, [])')) {
    return storedNote ? [{ aboutNodeIds: storedNote.aboutNodeIds, aboutPaths: storedNote.aboutPaths }] : [];
  }
  if (query.includes('SET n.content')) {
    Object.assign(storedNote!, {
      aboutNodeIds: params.aboutNodeIds,
      aboutPaths: params.aboutPaths,
      aboutPathHashes: params.aboutPathHashes,
    });
    return [{ noteId: params.noteId, topic: 'topic', content: 'content', lastValidated: 1 }];
  }
  if (query === MOVE_NOTE_QUERY) return [{ noteId: params.noteId, chunks: 2 }];
  if (query.includes('RETURN count(r) AS dropped')) return [{ dropped: 1 }];
  if (query.includes('nodeEdges + fileEdges')) return [{ created: 3 }];
  if (query.includes('MATCH (n:SessionNote)\n  WHERE n.projectId IN $projectIds'))
    return storedNote ? [storedNote] : [];
  return [];
};

const handlerOf = (createTool: (server: McpServer) => void) => {
  const registerTool = vi.fn();
  createTool({ registerTool } as unknown as McpServer);
  return registerTool.mock.calls[0][2];
};
const resultText = (response: { content: Array<{ text: string }> }) => response.content[0].text;
const resultJson = (response: { content: Array<{ text: string }> }) => JSON.parse(resultText(response));
const callsTo = (fragment: string) => run.mock.calls.filter(([query]) => query.includes(fragment));

// The handlers receive input after zod has applied its defaults, so the tests pass the same defaults.
const save = async (args: Record<string, unknown>) =>
  handlerOf(createSessionSaveTool)({ sessionId: 's', agentId: 'a', type: 'auto', severity: 'info', ...args });
const saveNote = (args: Record<string, unknown> = {}) =>
  save({ projectId: 'proj_code', topic: 'a topic', content: 'a note about the code', category: 'insight', ...args });
const recall = async (args: Record<string, unknown>) =>
  handlerOf(createSessionRecallTool)({
    includeCode: true,
    snippetLength: 500,
    limit: 5,
    includeSuperseded: false,
    ...args,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  storedNote = null;
  run.mockImplementation(fakeRun);
  directory = await mkdtemp(join(tmpdir(), 'session-anchors-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('session_save anchors', () => {
  it('matches each node id on the project in its prefix and reports the ones with no node', async () => {
    const saved = resultJson(await saveNote({ aboutNodeIds: [OTHER_PROJECT_NODE, UNPARSED_NODE, 'not-a-node-id'] }));

    const [, createParams] = callsTo('CREATE (n:SessionNote')[0];
    expect(createParams.nodeRefs).toEqual([
      { id: OTHER_PROJECT_NODE, projectId: 'proj_other' },
      { id: UNPARSED_NODE, projectId: 'proj_gone' },
    ]);
    expect(createParams.aboutNodeIds).toEqual([OTHER_PROJECT_NODE, UNPARSED_NODE, 'not-a-node-id']);
    expect(saved.note.unresolvedAboutNodeIds).toEqual([UNPARSED_NODE, 'not-a-node-id']);
  });

  it('stores absolute paths with content hashes and reports the path that is not on disk', async () => {
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src', 'a.ts'), 'hello');

    const saved = resultJson(await saveNote({ aboutPaths: ['src/a.ts', 'src', join(directory, 'gone.ts')] }));

    const [, createParams] = callsTo('CREATE (n:SessionNote')[0];
    expect(createParams.aboutPaths).toEqual([
      join(directory, 'src/a.ts'),
      join(directory, 'src'),
      join(directory, 'gone.ts'),
    ]);
    expect(createParams.aboutPathHashes).toEqual([SHA256_OF_HELLO, '', '']);
    expect(createParams.sourceFileRefs).toEqual(
      createParams.aboutPaths.map((filePath: string) => ({ projectId: 'proj_code', filePath })),
    );
    expect(saved.note.missingAboutPaths).toEqual([join(directory, 'gone.ts')]);
    expect(saved.note.unresolvedAboutNodeIds).toEqual([]);
  });

  it('links no SourceFile for a path outside every codebase', async () => {
    await saveNote({ projectId: 'proj_notes', aboutPaths: ['/outside/everything.md'] });

    expect(callsTo('CREATE (n:SessionNote')[0][1].sourceFileRefs).toEqual([]);
  });

  it('rejects a relative path in a collection before writing anything', async () => {
    const response = await saveNote({ projectId: 'proj_notes', aboutPaths: ['docs/a.md'] });

    expect(resultText(response)).toContain(
      "Path 'docs/a.md' is relative, but project 'notes' (proj_notes) is a collection",
    );
    expect(callsTo('CREATE (')).toEqual([]);
  });

  it('saves a bookmark that has only workingSetPaths', async () => {
    await writeFile(join(directory, 'plan.md'), 'hello');

    const saved = resultJson(
      await save({
        projectId: 'proj_code',
        summary: 'Working on the plan',
        taskContext: 'plan',
        workingSetPaths: ['plan.md', join(directory, 'missing.md')],
      }),
    );

    expect(saved.type).toBe('bookmark');
    expect(saved.bookmark.workingSetPaths).toEqual([join(directory, 'plan.md'), join(directory, 'missing.md')]);
    expect(saved.bookmark.missingWorkingSetPaths).toEqual([join(directory, 'missing.md')]);
    expect(callsTo('CREATE (b:SessionBookmark')[0][1].workingSetNodeIds).toEqual([]);
  });

  it('rejects a bookmark with neither node ids nor paths', async () => {
    const response = await save({
      projectId: 'proj_code',
      type: 'bookmark',
      summary: 'Working on nothing yet',
      taskContext: 'nothing',
    });

    expect(resultText(response)).toContain('A bookmark needs workingSetNodeIds or workingSetPaths.');
    expect(callsTo('CREATE (b:SessionBookmark')).toEqual([]);
  });
});

describe('session_recall', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', 'false');
    vi.stubEnv('EMBEDDING_MODEL', 'BAAI/bge-base-en-v1.5');
    vi.stubEnv('RERANK_MODEL', 'none');
  });

  /** Vector candidates at these scores, with no keyword or code match, so only the vector floor decides. */
  const withVectorCandidates = (scores: Record<string, number>) =>
    run.mockImplementation(async (query: string, params: Record<string, any>) => {
      if (query.includes('VECTOR INDEX session_notes_idx')) {
        return Object.entries(scores).map(([id, score]) => ({ id, score }));
      }
      if (query.includes('WHERE n.id IN $ids')) {
        return params.ids.map((id: string) => ({ id, projectId: 'proj_code', topic: id, content: '', aboutPaths: [] }));
      }
      return fakeRun(query, params);
    });

  const recalledIds = async (input: Record<string, unknown>) =>
    (resultJson(await recall(input)).notes ?? []).map((note: { id: string }) => note.id);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('holds vector-only notes to the calibrated floor and bookmarks to the uncalibrated one when minSimilarity is absent', async () => {
    withVectorCandidates({ above: 0.81, below: 0.79 });

    expect(await recalledIds({ projectId: 'proj_code', query: 'retry cap' })).toEqual(['above']);
    expect(callsTo('VECTOR INDEX session_bookmarks_idx')[0][1].minSimilarity).toBe(0.3);
  });

  it('holds them to the long-standing default under a model with no calibration', async () => {
    vi.stubEnv('EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2');
    withVectorCandidates({ above: 0.31, below: 0.29 });

    expect(await recalledIds({ projectId: 'proj_code', query: 'retry cap' })).toEqual(['above']);
  });

  it('holds them to the caller minSimilarity when one is given', async () => {
    withVectorCandidates({ above: 0.56, below: 0.54 });

    expect(await recalledIds({ projectId: 'proj_code', query: 'retry cap', minSimilarity: 0.55 })).toEqual(['above']);
  });

  it('says no note was close enough and how to see weaker matches when a query finds nothing', async () => {
    const message = resultText(await recall({ projectId: 'proj_code', query: 'retry cap' }));

    expect(message).toContain('No note was close enough to the query');
    expect(message).toContain('lower minSimilarity to show weaker matches');
  });

  it('searches the union of projectId and projectIds once per project and names each project in the result', async () => {
    await saveNote();

    const recalled = resultJson(await recall({ projectId: 'proj_code', projectIds: ['proj_code', 'notes'] }));

    expect(callsTo('MATCH (n:SessionNote)')[0][1].projectIds).toEqual(['proj_code', 'proj_notes']);
    expect(recalled.projects).toEqual([
      { projectId: 'proj_code', name: 'code', kind: 'codebase' },
      { projectId: 'proj_notes', name: 'notes', kind: 'collection' },
    ]);
  });

  it('names every input that failed to resolve', async () => {
    const response = await recall({ projectIds: ['proj_code', 'nope', 'nada'] });

    const message = resultText(response);
    expect(message).toContain('2 of 3 projects not found.');
    expect(message).toContain("'nope': No project has id, name or directory name 'nope'.");
    expect(message).toContain("'nada': No project has id, name or directory name 'nada'.");
    expect(callsTo('SessionNote)')).toEqual([]);
  });

  it('asks for a project when none is given', async () => {
    expect(resultText(await recall({}))).toContain('Pass projectId or projectIds.');
  });

  it('runs the semantic search as CYPHER 25 with one filtered SEARCH per index and project ids as a parameter', async () => {
    await recall({ projectIds: ['proj_code', 'proj_other'], query: 'retry cap' });

    const [query, params] = callsTo('VECTOR INDEX session_notes_idx')[0];
    expect(query.startsWith('CYPHER 25')).toBe(true);
    expect(query.match(/SEARCH /g)).toHaveLength(2);
    expect(query).not.toContain('queryNodes');
    expect(params.projectIds).toEqual(['proj_code', 'proj_other']);
    expect(params.queryEmbedding).toEqual([0.1, 0.2]);
  });

  it('searches bookmarks by meaning across the projects when there is a query and no session', async () => {
    await recall({ projectIds: ['proj_code', 'proj_other'], query: 'retry cap' });

    const [query, params] = callsTo('VECTOR INDEX session_bookmarks_idx')[0];
    expect(query.startsWith('CYPHER 25')).toBe(true);
    expect(params.projectIds).toEqual(['proj_code', 'proj_other']);
  });

  it('reports a file that is gone, and a file edited after the save, until the note is updated', async () => {
    const edited = join(directory, 'edited.ts');
    const gone = join(directory, 'gone.ts');
    await writeFile(edited, 'hello');
    await writeFile(gone, 'hello');
    await saveNote({ aboutPaths: [edited, gone] });

    const unchanged = resultJson(await recall({ projectId: 'proj_code' })).notes[0];
    expect(unchanged.projectId).toBe('proj_code');
    expect(unchanged.aboutPaths).toEqual([edited, gone]);
    expect(unchanged.missingAboutPaths).toEqual([]);
    expect(unchanged.changedAboutPaths).toEqual([]);

    await writeFile(edited, 'hello, edited');
    await rm(gone);
    const stale = resultJson(await recall({ projectId: 'proj_code' }));
    expect(stale.notes[0].missingAboutPaths).toEqual([gone]);
    expect(stale.notes[0].changedAboutPaths).toEqual([edited]);
    expect(stale.stats.notesWithStaleRefs).toBe(1);

    await handlerOf(createSessionUpdateTool)({ projectId: 'proj_code', noteId: storedNote!.id, aboutPaths: [edited] });
    const refreshed = resultJson(await recall({ projectId: 'proj_code' })).notes[0];
    expect(refreshed.aboutPaths).toEqual([edited]);
    expect(refreshed.missingAboutPaths).toEqual([]);
    expect(refreshed.changedAboutPaths).toEqual([]);
  });
});

describe('session_update anchors', () => {
  it('drops and rebuilds the edges from the new paths and node ids', async () => {
    await writeFile(join(directory, 'a.ts'), 'hello');
    await saveNote();

    const updated = resultJson(
      await handlerOf(createSessionUpdateTool)({
        projectId: 'proj_code',
        noteId: storedNote!.id,
        aboutNodeIds: [OTHER_PROJECT_NODE],
        aboutPaths: ['a.ts'],
      }),
    );

    const [, updateParams] = callsTo('SET n.content')[0];
    expect(updateParams.aboutNodeIds).toEqual([OTHER_PROJECT_NODE]);
    expect(updateParams.aboutPaths).toEqual([join(directory, 'a.ts')]);
    expect(updateParams.aboutPathHashes).toEqual([SHA256_OF_HELLO]);
    expect(callsTo('RETURN count(r) AS dropped')).toHaveLength(1);
    expect(callsTo('nodeEdges + fileEdges')[0][1]).toMatchObject({
      nodeRefs: [{ id: OTHER_PROJECT_NODE, projectId: 'proj_other' }],
      sourceFileRefs: [{ projectId: 'proj_code', filePath: join(directory, 'a.ts') }],
    });
    expect(updated.aboutEdges).toEqual({ dropped: 1, created: 3 });
    expect(updated.fieldsUpdated).toMatchObject({ aboutNodeIds: true, aboutPaths: true });
  });

  it('re-hashes the stored anchors on an update that sends none, and leaves the edges alone', async () => {
    const file = join(directory, 'a.ts');
    await writeFile(file, 'hello');
    await saveNote({ aboutPaths: [file] });
    await writeFile(file, 'hello, edited');

    const updated = resultJson(
      await handlerOf(createSessionUpdateTool)({ projectId: 'proj_code', noteId: storedNote!.id, severity: 'warning' }),
    );

    const [, updateParams] = callsTo('SET n.content')[0];
    expect(updateParams.aboutPaths).toEqual([file]);
    expect(updateParams.aboutPathHashes).not.toEqual([SHA256_OF_HELLO]);
    expect(updateParams.aboutPathHashes[0]).toHaveLength(64);
    expect(callsTo('RETURN count(r) AS dropped')).toEqual([]);
    expect(updated.aboutEdges).toBeNull();
  });
});

describe('session_update moveToProjectId', () => {
  it('moves the note and its chunks to the target, leaves the anchors alone and says where it went', async () => {
    await saveNote({ aboutNodeIds: [OTHER_PROJECT_NODE] });

    const updated = resultJson(
      await handlerOf(createSessionUpdateTool)({
        projectId: 'proj_code',
        noteId: storedNote!.id,
        moveToProjectId: 'notes',
      }),
    );

    expect(callsTo('SET n.projectId')[0][1]).toEqual({
      projectId: 'proj_code',
      noteId: storedNote!.id,
      targetProjectId: 'proj_notes',
    });
    expect(callsTo('RETURN count(r) AS dropped')).toEqual([]);
    expect(updated.projectId).toBe('proj_notes');
    expect(updated.moved).toEqual({ from: 'proj_code', to: 'proj_notes', toName: 'notes', chunks: 2 });
  });

  it("does nothing for a move to the note's current project", async () => {
    await saveNote();

    const updated = resultJson(
      await handlerOf(createSessionUpdateTool)({
        projectId: 'proj_code',
        noteId: storedNote!.id,
        moveToProjectId: 'code',
        severity: 'warning',
      }),
    );

    expect(callsTo('SET n.projectId')).toEqual([]);
    expect(updated.moved).toBeNull();
    expect(updated.projectId).toBe('proj_code');
  });

  it('writes nothing when the target project is not found', async () => {
    await saveNote();
    const writesBefore = callsTo('SET n.content').length;

    const response = await handlerOf(createSessionUpdateTool)({
      projectId: 'proj_code',
      noteId: storedNote!.id,
      moveToProjectId: 'no-such-project',
    });

    expect(response.isError).toBe(true);
    expect(resultText(response)).toContain('No project has id, name or directory name');
    expect(callsTo('SET n.content')).toHaveLength(writesBefore);
    expect(callsTo('SET n.projectId')).toEqual([]);
  });
});
