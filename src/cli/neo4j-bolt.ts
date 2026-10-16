import neo4j from 'neo4j-driver';

import { Neo4jConnection } from '../storage/neo4j/neo4j-connection.js';

export const BOLT_PROBE_TIMEOUT_MS = 3000;
export const BOLT_WAIT_TIMEOUT_MS = 120000;
export const BOLT_WAIT_INTERVAL_MS = 2000;

export const queryBolt = async (
  { uri, user, password }: Neo4jConnection,
  cypher: string,
  timeoutMs: number = BOLT_PROBE_TIMEOUT_MS,
): Promise<Record<string, unknown>[]> => {
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    connectionTimeout: timeoutMs,
    maxTransactionRetryTime: timeoutMs,
  });
  try {
    const session = driver.session();
    try {
      const result = await session.run(cypher, {}, { timeout: timeoutMs });
      return result.records.map((record) => record.toObject());
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
};

export const probeBolt = async (
  connection: Neo4jConnection,
  timeoutMs: number = BOLT_PROBE_TIMEOUT_MS,
): Promise<boolean> => {
  try {
    await queryBolt(connection, 'RETURN 1', timeoutMs);
    return true;
  } catch {
    return false;
  }
};

export const waitForBolt = async (
  connection: Neo4jConnection,
  timeoutMs: number = BOLT_WAIT_TIMEOUT_MS,
  intervalMs: number = BOLT_WAIT_INTERVAL_MS,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeBolt(connection)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
};

export const isApocAvailable = async (connection: Neo4jConnection): Promise<boolean> => {
  try {
    await queryBolt(connection, 'RETURN apoc.version() AS version');
    return true;
  } catch {
    return false;
  }
};
