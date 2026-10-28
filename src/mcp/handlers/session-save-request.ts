import type { NoteCategory, NoteSeverity } from '../../core/session/note-vocabulary.js';

/** The session_save arguments the request is built from, after zod has applied its defaults. */
export interface SaveRequestArgs {
  type: 'bookmark' | 'note' | 'auto';
  summary?: string;
  workingSetNodeIds?: string[];
  workingSetPaths?: string[];
  taskContext?: string;
  findings?: string;
  nextSteps?: string;
  topic?: string;
  content?: string;
  category?: NoteCategory;
  severity: NoteSeverity;
  aboutNodeIds?: string[];
  aboutPaths?: string[];
  supersededBy?: string | null;
  supersedes?: string[];
  expiresInHours?: number;
  metadata?: string;
}

export interface BookmarkSaveInput {
  summary: string;
  taskContext: string;
  workingSetNodeIds: string[];
  workingSetPaths: string[];
  findings: string;
  nextSteps: string;
  metadata: string | null;
}

export interface NoteSaveInput {
  topic: string;
  content: string;
  category: NoteCategory;
  severity: NoteSeverity;
  aboutNodeIds: string[];
  aboutPaths: string[];
  supersededBy: string | null;
  supersedes: string[];
  expiresInHours?: number;
}

export type SaveRequest =
  | { kind: 'bookmark'; bookmark: BookmarkSaveInput }
  | { kind: 'note'; note: NoteSaveInput }
  | { kind: 'both'; bookmark: BookmarkSaveInput; note: NoteSaveInput };

export type SaveRequestResult = { success: true; request: SaveRequest } | { success: false; error: string };

type Validated<T> = { success: true; value: T } | { success: false; error: string };

const parseBookmark = (args: SaveRequestArgs): Validated<BookmarkSaveInput> => {
  const workingSetNodeIds = args.workingSetNodeIds ?? [];
  const workingSetPaths = args.workingSetPaths ?? [];
  if (!args.summary) return { success: false, error: 'summary is required when saving a bookmark.' };
  if (!args.taskContext) return { success: false, error: 'taskContext is required when saving a bookmark.' };
  if (workingSetNodeIds.length === 0 && workingSetPaths.length === 0) {
    return {
      success: false,
      error:
        'A bookmark needs workingSetNodeIds or workingSetPaths. Pass the code nodes or the files and folders you are working on.',
    };
  }
  return {
    success: true,
    value: {
      summary: args.summary,
      taskContext: args.taskContext,
      workingSetNodeIds,
      workingSetPaths,
      findings: args.findings ?? '',
      nextSteps: args.nextSteps ?? '',
      metadata: args.metadata ?? null,
    },
  };
};

const parseNote = (args: SaveRequestArgs): Validated<NoteSaveInput> => {
  if (!args.topic) return { success: false, error: 'topic is required when saving a note.' };
  if (!args.content) return { success: false, error: 'content is required when saving a note.' };
  if (!args.category) return { success: false, error: 'category is required when saving a note.' };
  return {
    success: true,
    value: {
      topic: args.topic,
      content: args.content,
      category: args.category,
      severity: args.severity,
      aboutNodeIds: args.aboutNodeIds ?? [],
      aboutPaths: args.aboutPaths ?? [],
      supersededBy: args.supersededBy ?? null,
      supersedes: args.supersedes ?? [],
      expiresInHours: args.expiresInHours,
    },
  };
};

const savedKind = (args: SaveRequestArgs): SaveRequest['kind'] | null => {
  if (args.type !== 'auto') return args.type;
  const hasBookmarkFields = (args.workingSetNodeIds ?? []).length > 0 || (args.workingSetPaths ?? []).length > 0;
  const hasNoteFields = args.topic != null && args.content != null;
  if (hasBookmarkFields && hasNoteFields) return 'both';
  if (hasBookmarkFields) return 'bookmark';
  if (hasNoteFields) return 'note';
  return null;
};

/** Decides whether the arguments save a bookmark, a note or both, and checks the fields that kind needs. */
export const parseSaveRequest = (args: SaveRequestArgs): SaveRequestResult => {
  const kind = savedKind(args);
  if (kind === null) {
    return {
      success: false,
      error:
        'Cannot auto-detect type: provide workingSetNodeIds or workingSetPaths for a bookmark, topic+content for a note, or both.',
    };
  }

  switch (kind) {
    case 'bookmark': {
      const bookmark = parseBookmark(args);
      if (!bookmark.success) return bookmark;
      if ((args.supersedes ?? []).length > 0) {
        return { success: false, error: 'supersedes applies only when saving a note.' };
      }
      return { success: true, request: { kind, bookmark: bookmark.value } };
    }
    case 'note': {
      const note = parseNote(args);
      if (!note.success) return note;
      return { success: true, request: { kind, note: note.value } };
    }
    case 'both': {
      const bookmark = parseBookmark(args);
      if (!bookmark.success) return bookmark;
      const note = parseNote(args);
      if (!note.success) return note;
      return { success: true, request: { kind, bookmark: bookmark.value, note: note.value } };
    }
  }
};
