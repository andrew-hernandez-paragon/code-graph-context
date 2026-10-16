import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionRecallTool } from '../session-recall.tool.js';
import { createSessionSaveTool } from '../session-save.tool.js';

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
    embedText = vi.fn().mockRejectedValue(new Error('embedding sidecar unavailable'));
  },
  getEmbeddingDimensions: () => 768,
}));
vi.mock('../../handlers/session-note-chunks.js', () => ({ saveSessionNoteChunks: vi.fn().mockResolvedValue(0) }));
vi.mock('../../utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils.js')>()),
  resolveProjectIdOrError: vi.fn(async (projectId: string) => ({ success: true, projectId })),
  debugLog: vi.fn(),
}));

interface StoredNote {
  id: string;
  projectId: string;
  topic: string;
  supersededBy: string | null;
}

interface QueryParams {
  noteId: string;
  projectId: string;
  topic: string;
  supersededBy: string | null;
  supersedes: string[];
  includeSuperseded: boolean;
}

// Stands in for Neo4j: models only the stored supersededBy property that the create and recall queries read and write.
let notes: Map<string, StoredNote>;

const fakeRun = async (query: string, params: QueryParams) => {
  if (query.includes('CREATE (n:SessionNote')) {
    notes.set(params.noteId, {
      id: params.noteId,
      projectId: params.projectId,
      topic: params.topic,
      supersededBy: params.supersededBy,
    });
    const markedIds = params.supersedes.filter((id) => notes.get(id)?.projectId === params.projectId);
    for (const id of markedIds) notes.get(id)!.supersededBy = params.noteId;
    const notFoundIds = params.supersedes.filter((id) => !markedIds.includes(id));
    return [{ noteId: params.noteId, markedIds, notFoundIds }];
  }
  if (query.includes('$includeSuperseded')) {
    return [...notes.values()].filter(
      (note) => note.projectId === params.projectId && (params.includeSuperseded || note.supersededBy === null),
    );
  }
  return [];
};

const handlerOf = (createTool: (server: McpServer) => void) => {
  const registerTool = vi.fn();
  createTool({ registerTool } as unknown as McpServer);
  return registerTool.mock.calls[0][2];
};
const resultJson = (response: { content: Array<{ text: string }> }) => JSON.parse(response.content[0].text);

const saveNote = async (topic: string, args: Record<string, unknown> = {}) =>
  resultJson(
    await handlerOf(createSessionSaveTool)({
      projectId: 'proj_test',
      sessionId: 'session',
      agentId: 'agent',
      topic,
      content: `${topic}, the full observation`,
      category: 'insight',
      ...args,
    }),
  );
const recallTopics = async (args: Record<string, unknown> = {}) => {
  const recalled = resultJson(await handlerOf(createSessionRecallTool)({ projectId: 'proj_test', ...args }));
  return recalled.notes.map((note: { topic: string }) => note.topic);
};

beforeEach(() => {
  vi.clearAllMocks();
  notes = new Map();
  run.mockImplementation(fakeRun);
});

describe('session_save supersedes', () => {
  it('marks the replaced note so recall returns the new note and not the old one', async () => {
    const old = await saveNote('retry cap is five');
    const replacement = await saveNote('retry cap is eight', { supersedes: [old.note.noteId] });

    expect(replacement.note.supersedes).toEqual({ marked: [old.note.noteId], notFound: [] });
    expect(notes.get(old.note.noteId)?.supersededBy).toBe(replacement.note.noteId);
    expect(notes.get(replacement.note.noteId)?.supersededBy).toBeNull();
    expect(await recallTopics()).toEqual(['retry cap is eight']);
    expect(await recallTopics({ includeSuperseded: true })).toEqual(['retry cap is five', 'retry cap is eight']);
  });

  it('reports ids it did not find, including notes from another project, and passes each id once', async () => {
    notes.set('note_other', { id: 'note_other', projectId: 'proj_other', topic: 'other', supersededBy: null });
    const old = await saveNote('retry cap is five');

    const replacement = await saveNote('retry cap is eight', {
      supersedes: [old.note.noteId, 'note_missing', 'note_other', old.note.noteId],
    });

    expect(replacement.note.supersedes).toEqual({
      marked: [old.note.noteId],
      notFound: ['note_missing', 'note_other'],
    });
    expect(notes.get('note_other')?.supersededBy).toBeNull();
    const createCall = run.mock.calls.filter(([query]) => query.includes('CREATE (n:SessionNote')).at(-1)!;
    expect(createCall[1].supersedes).toEqual([old.note.noteId, 'note_missing', 'note_other']);
  });

  it('keeps supersededBy on save marking the new note itself as superseded', async () => {
    const old = await saveNote('retry cap is five');
    const saved = await saveNote('retry cap was three', { supersededBy: old.note.noteId });

    expect(saved.note.supersedes).toBeUndefined();
    expect(notes.get(saved.note.noteId)?.supersededBy).toBe(old.note.noteId);
    expect(await recallTopics()).toEqual(['retry cap is five']);
  });

  it('rejects supersedes on a bookmark-only save', async () => {
    const response = await handlerOf(createSessionSaveTool)({
      projectId: 'proj_test',
      sessionId: 'session',
      agentId: 'agent',
      summary: 'Working on the retry cap',
      taskContext: 'retry cap',
      workingSetNodeIds: ['node'],
      supersedes: ['note_old'],
    });

    expect(response.content[0].text).toContain('supersedes applies only when saving a note.');
    expect(run.mock.calls.some(([query]) => query.includes('CREATE (b:SessionBookmark'))).toBe(false);
  });
});
