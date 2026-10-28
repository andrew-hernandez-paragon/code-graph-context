export const NOTE_CATEGORIES = ['architectural', 'bug', 'insight', 'decision', 'risk', 'todo'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const NOTE_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NoteSeverity = (typeof NOTE_SEVERITIES)[number];
