export const PROJECT_KINDS = ['codebase', 'directory', 'collection'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/** Values of `Project.status` that only the TypeScript parse path writes. */
export const PARSE_STATUSES = ['parsing', 'complete', 'failed'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

/**
 * A node's kind. Servers that predate `kind` still write Project nodes without it, so every read
 * and the startup backfill derive the missing value from this one rule.
 */
export const projectKindCypher = (alias: string = 'p'): string => `coalesce(${alias}.kind,
    CASE
      WHEN ${alias}.status IN [${PARSE_STATUSES.map((status) => `'${status}'`).join(', ')}] THEN 'codebase'
      WHEN ${alias}.path IS NOT NULL THEN 'directory'
      ELSE 'collection'
    END)`;
