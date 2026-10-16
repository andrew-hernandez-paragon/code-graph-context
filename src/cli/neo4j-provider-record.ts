import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type Neo4jProviderName = 'native' | 'docker';

export interface Neo4jProviderRecord {
  provider: Neo4jProviderName;
  boltPort: number;
  httpPort: number;
}

export const getConfigDir = (): string =>
  process.env.CGC_CONFIG_DIR ?? join(homedir(), '.config', 'code-graph-context');

const getRecordPath = (): string => join(getConfigDir(), 'config.json');

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isProviderName = (value: unknown): value is Neo4jProviderName => value === 'native' || value === 'docker';

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;

const parseRecord = (value: unknown): Neo4jProviderRecord | null => {
  if (!isObject(value) || !isObject(value.neo4j)) return null;
  const { provider, boltPort, httpPort } = value.neo4j;
  if (!isProviderName(provider) || !isPort(boltPort) || !isPort(httpPort)) return null;
  return { provider, boltPort, httpPort };
};

/** Returns null when the file is missing or does not hold a valid record. */
export const readProviderRecord = (): Neo4jProviderRecord | null => {
  try {
    return parseRecord(JSON.parse(readFileSync(getRecordPath(), 'utf-8')));
  } catch {
    return null;
  }
};

export const writeProviderRecord = (record: Neo4jProviderRecord): void => {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getRecordPath(), `${JSON.stringify({ neo4j: record }, null, 2)}\n`);
};
