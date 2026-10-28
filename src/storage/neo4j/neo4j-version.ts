/**
 * Neo4j server version and the floor for project-filtered vector search.
 * CYPHER 25 `SEARCH` and `CREATE VECTOR INDEX ... WITH [n.projectId]` need 2026.02 or later;
 * earlier servers reject both statements.
 */

import type { Neo4jService } from './neo4j.service.js';

export interface Neo4jVersion {
  major: number;
  minor: number;
  patch: number;
}

export const MIN_FILTERED_SEARCH_VERSION: Neo4jVersion = { major: 2026, minor: 2, patch: 0 };

export const parseNeo4jVersion = (text: string): Neo4jVersion | null => {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) } : null;
};

export const supportsProjectFilteredSearch = (version: Neo4jVersion): boolean =>
  version.major !== MIN_FILTERED_SEARCH_VERSION.major
    ? version.major > MIN_FILTERED_SEARCH_VERSION.major
    : version.minor >= MIN_FILTERED_SEARCH_VERSION.minor;

export const formatNeo4jVersion = (version: Neo4jVersion): string =>
  `${version.major}.${version.major >= 2000 ? String(version.minor).padStart(2, '0') : version.minor}.${version.patch}`;

/** The server's Kernel version string, or null when the server does not report one this module can parse. */
export const readNeo4jVersion = async (db: Pick<Neo4jService, 'run'>): Promise<Neo4jVersion | null> => {
  const rows = await db.run(
    'CALL dbms.components() YIELD name, versions WHERE name = "Neo4j Kernel" RETURN versions[0] AS version',
  );
  const version = rows[0]?.version;
  return typeof version === 'string' ? parseNeo4jVersion(version) : null;
};

export const NEO4J_VERSION_FLOOR_LABEL = `${MIN_FILTERED_SEARCH_VERSION.major}.${String(MIN_FILTERED_SEARCH_VERSION.minor).padStart(2, '0')}`;

/** One message that names what was found, the floor, and the fix for each provider. */
export const describeOldNeo4j = (found: Neo4jVersion): string =>
  `Neo4j ${formatNeo4jVersion(found)} is older than ${NEO4J_VERSION_FLOOR_LABEL}, which project-filtered vector search needs. ` +
  `Upgrade it: for the native provider run "brew upgrade neo4j"; for Docker use a ${NEO4J_VERSION_FLOOR_LABEL} or newer image ` +
  `(an existing 5.x Docker graph must move with "code-graph-context migrate-from-docker"). Vector indexes were not rebuilt and vector search will fail until then.`;
