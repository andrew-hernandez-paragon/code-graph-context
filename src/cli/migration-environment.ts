/**
 * The native Neo4j target and the provider record that `migrate-from-docker` runs against.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { getNeo4jConnection, Neo4jConnection } from '../storage/neo4j/neo4j-connection.js';

import { MigrationTarget, ProviderName, ProviderRecord } from './migrate-from-docker.js';
import { createNativeNeo4jProvider, NativeNeo4jProvider } from './neo4j-native.js';
import { writeProviderRecord } from './neo4j-provider-record.js';

export interface MigrationEnvironment {
  target: MigrationTarget;
  provider: ProviderRecord;
}

export interface ListenPorts {
  boltPort: number;
  httpPort: number;
}

const DEFAULT_PORTS: ListenPorts = { boltPort: 7687, httpPort: 7474 };

const portOf = (conf: string, key: string): number | null => {
  const match = new RegExp(`^${key.replace(/\./g, '\\.')}=.*:(\\d+)\\s*$`, 'm').exec(conf);
  return match ? Number(match[1]) : null;
};

/** The Bolt and HTTP ports `configure` wrote into the native neo4j.conf, or null when either is missing. */
export const readListenPorts = (conf: string): ListenPorts | null => {
  const boltPort = portOf(conf, 'server.bolt.listen_address');
  const httpPort = portOf(conf, 'server.http.listen_address');
  return boltPort === null || httpPort === null ? null : { boltPort, httpPort };
};

export class NativeMigrationTarget implements MigrationTarget {
  constructor(
    private readonly native: NativeNeo4jProvider,
    private readonly ports: ListenPorts,
    private readonly credentials: Pick<Neo4jConnection, 'user' | 'password'>,
  ) {}

  get connection(): Neo4jConnection {
    return { uri: `bolt://localhost:${this.ports.boltPort}`, ...this.credentials };
  }

  describe(): string {
    return `native Neo4j at ${this.native.paths.home}`;
  }

  async neo4jVersion(): Promise<string> {
    const version = await this.native.neo4jVersion();
    if (version === null) throw new Error('Homebrew Neo4j did not report its version');
    return version;
  }

  isConfigured(): Promise<boolean> {
    return this.native.isConfigured();
  }

  hasData(): Promise<boolean> {
    return this.native.hasData();
  }

  /** Disabled as well as stopped, so a rollback to Docker does not bring the native Neo4j back at login. */
  async stop(): Promise<void> {
    await this.native.stopService();
    await this.native.disableService();
  }

  async load(dumpDir: string): Promise<void> {
    const result = await this.native.runAdmin([
      'database',
      'load',
      'neo4j',
      `--from-path=${dumpDir}`,
      '--overwrite-destination=true',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`neo4j-admin database load failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
    }
  }

  start(): Promise<void> {
    return this.native.startService();
  }
}

export class ConfigFileProviderRecord implements ProviderRecord {
  constructor(private readonly ports: ListenPorts) {}

  async setProvider(provider: ProviderName): Promise<void> {
    writeProviderRecord({ provider, ...this.ports });
  }
}

export const createMigrationEnvironment = async (): Promise<MigrationEnvironment> => {
  const native = createNativeNeo4jProvider();
  const conf = await readFile(join(native.paths.conf, 'neo4j.conf'), 'utf-8').catch(() => '');
  // An unconfigured target fails the migration's precondition check; the default ports only label it.
  const ports = readListenPorts(conf) ?? DEFAULT_PORTS;
  const { user, password } = getNeo4jConnection();
  return {
    target: new NativeMigrationTarget(native, ports, { user, password }),
    provider: new ConfigFileProviderRecord(ports),
  };
};
