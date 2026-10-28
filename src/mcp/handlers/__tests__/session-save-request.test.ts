import { describe, expect, it } from 'vitest';

import { parseSaveRequest, type SaveRequestArgs } from '../session-save-request.js';

const args = (overrides: Partial<SaveRequestArgs>): SaveRequestArgs => ({
  type: 'auto',
  severity: 'info',
  ...overrides,
});

const bookmarkFields = { summary: 'Working on the retry cap', taskContext: 'retry cap', workingSetPaths: ['src'] };
const noteFields = { topic: 'retry cap', content: 'The retry cap is five', category: 'insight' as const };

describe('parseSaveRequest', () => {
  it('reads a bookmark from working set fields and fills the optional text with empty strings', () => {
    const parsed = parseSaveRequest(args(bookmarkFields));

    expect(parsed).toEqual({
      success: true,
      request: {
        kind: 'bookmark',
        bookmark: {
          summary: 'Working on the retry cap',
          taskContext: 'retry cap',
          workingSetNodeIds: [],
          workingSetPaths: ['src'],
          findings: '',
          nextSteps: '',
          metadata: null,
        },
      },
    });
  });

  it('reads a note from topic and content, with no anchors, supersedes or superseded note by default', () => {
    expect(parseSaveRequest(args(noteFields))).toEqual({
      success: true,
      request: {
        kind: 'note',
        note: {
          topic: 'retry cap',
          content: 'The retry cap is five',
          category: 'insight',
          severity: 'info',
          aboutNodeIds: [],
          aboutPaths: [],
          supersededBy: null,
          supersedes: [],
          expiresInHours: undefined,
        },
      },
    });
  });

  it('reads both when the fields for a bookmark and a note are present', () => {
    const parsed = parseSaveRequest(args({ ...bookmarkFields, ...noteFields }));

    expect(parsed.success && parsed.request.kind).toBe('both');
  });

  it('asks for the fields of one kind when auto-detect finds none', () => {
    expect(parseSaveRequest(args({ summary: 'only a summary here' }))).toEqual({
      success: false,
      error:
        'Cannot auto-detect type: provide workingSetNodeIds or workingSetPaths for a bookmark, topic+content for a note, or both.',
    });
  });

  it.each([
    ['summary', { ...bookmarkFields, summary: undefined }, 'summary is required when saving a bookmark.'],
    ['taskContext', { ...bookmarkFields, taskContext: undefined }, 'taskContext is required when saving a bookmark.'],
    ['topic', { ...noteFields, topic: undefined, type: 'note' as const }, 'topic is required when saving a note.'],
    [
      'content',
      { ...noteFields, content: undefined, type: 'note' as const },
      'content is required when saving a note.',
    ],
    ['category', { ...noteFields, category: undefined }, 'category is required when saving a note.'],
  ])('rejects a save missing %s', (_field, overrides, error) => {
    expect(parseSaveRequest(args(overrides))).toEqual({ success: false, error });
  });

  it('rejects a forced bookmark with an empty working set', () => {
    const parsed = parseSaveRequest(args({ type: 'bookmark', summary: 'Working on nothing yet', taskContext: 'x' }));

    expect(parsed).toMatchObject({
      success: false,
      error: expect.stringContaining('A bookmark needs workingSetNodeIds or workingSetPaths.'),
    });
  });

  it('rejects supersedes on a bookmark-only save', () => {
    expect(parseSaveRequest(args({ ...bookmarkFields, supersedes: ['note_old'] }))).toEqual({
      success: false,
      error: 'supersedes applies only when saving a note.',
    });
  });

  it('keeps supersedes on a save of both', () => {
    const parsed = parseSaveRequest(args({ ...bookmarkFields, ...noteFields, supersedes: ['note_old'] }));

    expect(parsed.success && parsed.request.kind === 'both' && parsed.request.note.supersedes).toEqual(['note_old']);
  });
});
