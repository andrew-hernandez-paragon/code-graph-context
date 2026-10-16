/**
 * Brings Neo4j up for the MCP server: reuse whatever already answers on Bolt, otherwise
 * start the provider that `init` recorded. Every step is safe to repeat, because many MCP
 * servers start at once and each runs this.
 */

import { probeBolt, waitForBolt } from '../cli/neo4j-bolt.js';
import { EnsureNeo4jResult, ensureNeo4jRunning, isDockerInstalled, isDockerRunning } from '../cli/neo4j-docker.js';
import { NativeNeo4jProvider, createNativeNeo4jProvider } from '../cli/neo4j-native.js';
import { Neo4jProviderRecord, readProviderRecord } from '../cli/neo4j-provider-record.js';
import { Neo4jConnection, getNeo4jConnection } from '../storage/neo4j/neo4j-connection.js';

export const STARTUP_RETRY_INTERVAL_MS = 30_000;
export const STARTUP_RETRY_MAX_ATTEMPTS = 20;

export type Neo4jStartupAction = 'already-reachable' | 'native-started' | 'docker-started' | 'docker-created';

export interface DockerNeo4j {
  isInstalled(): boolean;
  isRunning(): boolean;
  ensureRunning(): Promise<EnsureNeo4jResult>;
}

export interface Neo4jStartupDependencies {
  getConnection(): Neo4jConnection;
  readProviderRecord(): Neo4jProviderRecord | null;
  probeBolt(connection: Neo4jConnection): Promise<boolean>;
  waitForBolt(connection: Neo4jConnection): Promise<boolean>;
  native: Pick<NativeNeo4jProvider, 'isConfigured' | 'startService' | 'paths'>;
  docker: DockerNeo4j;
}

export class Neo4jStartupService {
  constructor(private readonly dependencies: Neo4jStartupDependencies) {}

  async ensureRunning(): Promise<Neo4jStartupAction> {
    const { getConnection, probeBolt: probe, readProviderRecord: readRecord } = this.dependencies;
    const connection = getConnection();
    if (await probe(connection)) return 'already-reachable';

    const record = readRecord();
    if (record?.provider === 'native') return this.startNative(connection);
    return this.startDocker(connection, record !== null);
  }

  private async startNative(connection: Neo4jConnection): Promise<Neo4jStartupAction> {
    const { native, waitForBolt: waitForReady } = this.dependencies;
    if (!(await native.isConfigured())) {
      throw new Error('Native Neo4j is not configured. Run: code-graph-context init');
    }
    await native.startService();
    if (!(await waitForReady(connection))) {
      throw new Error(`Neo4j did not answer at ${connection.uri} after starting the service. See ${native.paths.logs}`);
    }
    return 'native-started';
  }

  private async startDocker(connection: Neo4jConnection, recorded: boolean): Promise<Neo4jStartupAction> {
    const { docker } = this.dependencies;
    if (!docker.isInstalled()) {
      throw new Error(
        recorded
          ? 'Docker not installed. Install Docker or run: code-graph-context init'
          : `Neo4j is not reachable at ${connection.uri}; run code-graph-context init`,
      );
    }
    if (!docker.isRunning()) {
      throw new Error('Docker not running. Start Docker or run: code-graph-context init');
    }
    const result = await docker.ensureRunning();
    if (!result.success) {
      throw new Error(`Neo4j failed to start: ${result.error}. Run: code-graph-context init`);
    }
    return result.action === 'created'
      ? 'docker-created'
      : result.action === 'started'
        ? 'docker-started'
        : 'already-reachable';
  }
}

export const createNeo4jStartupService = (): Neo4jStartupService =>
  new Neo4jStartupService({
    getConnection: getNeo4jConnection,
    readProviderRecord,
    probeBolt,
    waitForBolt,
    native: createNativeNeo4jProvider(),
    docker: { isInstalled: isDockerInstalled, isRunning: isDockerRunning, ensureRunning: ensureNeo4jRunning },
  });

export interface BackgroundRetryOptions {
  attempt(): Promise<void>;
  onAttempt(attemptNumber: number, maxAttempts: number): void;
  onFailure(attemptNumber: number, error: unknown): void;
  intervalMs?: number;
  maxAttempts?: number;
}

/** Calls `attempt` every interval until it resolves; true if it did, false once attempts run out. */
export const retryInBackground = async ({
  attempt,
  onAttempt,
  onFailure,
  intervalMs = STARTUP_RETRY_INTERVAL_MS,
  maxAttempts = STARTUP_RETRY_MAX_ATTEMPTS,
}: BackgroundRetryOptions): Promise<boolean> => {
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs).unref());
    onAttempt(attemptNumber, maxAttempts);
    try {
      await attempt();
      return true;
    } catch (error) {
      onFailure(attemptNumber, error);
    }
  }
  return false;
};
