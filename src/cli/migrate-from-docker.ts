/**
 * `code-graph-context migrate-from-docker`: move the graph held by a Docker Neo4j container into the
 * native Neo4j, keeping every node, relationship, property (embeddings included) and index.
 *
 * Neo4j cannot load a store older than 5.26 into 2026.x, so a source older than 5.26 takes a hop:
 * its dump is loaded into a throwaway 5.26 container, started once to upgrade the store, and dumped again.
 * The source container and its volume are only ever stopped, never deleted.
 */

import { homedir } from 'os';
import { basename, dirname, join } from 'path';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(file: string, args: string[]): Promise<CommandResult>;
}

export interface BoltEndpoint {
  uri: string;
  user: string;
  password: string;
}

export interface IndexDefinition {
  name: string;
  type: string;
  state: string;
  populationPercent: number;
  labelsOrTypes: string[];
  properties: string[];
}

export interface GraphSnapshot {
  nodeCount: number;
  relationshipCount: number;
  labelCounts: Record<string, number>;
  indexes: IndexDefinition[];
}

export interface BoltClient {
  isReachable(endpoint: BoltEndpoint): Promise<boolean>;
  captureGraphSnapshot(endpoint: BoltEndpoint): Promise<GraphSnapshot>;
}

export interface MigrationFileSystem {
  makeDirectory(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  listDirectories(path: string): Promise<string[]>;
  sizeInBytes(path: string): Promise<number>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export type ProviderName = 'native' | 'docker';

export interface ProviderRecord {
  setProvider(provider: ProviderName): Promise<void>;
}

export interface MigrationTarget {
  describe(): string;
  neo4jVersion(): Promise<string>;
  isConfigured(): Promise<boolean>;
  hasData(): Promise<boolean>;
  stop(): Promise<void>;
  load(dumpDir: string): Promise<void>;
  start(): Promise<void>;
  readonly connection: BoltEndpoint;
}

export interface MigrateFromDockerOptions {
  container: string;
  fromDump?: string;
  overwrite?: boolean;
  rollback?: boolean;
}

export interface MigrationSettings {
  /** Prefix of every container and volume this command creates. */
  resourcePrefix: string;
  pollIntervalMs: number;
  bootWaitMs: number;
  indexWaitMs: number;
  stopTimeoutSeconds: number;
}

export const DEFAULT_MIGRATION_SETTINGS: MigrationSettings = {
  resourcePrefix: 'cgc-migrate-',
  pollIntervalMs: 3000,
  bootWaitMs: 10 * 60 * 1000,
  indexWaitMs: 10 * 60 * 1000,
  stopTimeoutSeconds: 300,
};

export type MigrationStatus = 'completed' | 'verification-failed' | 'failed' | 'rolled-back';

export interface MigrationDependencies {
  commands: CommandRunner;
  bolt: BoltClient;
  files: MigrationFileSystem;
  clock: Clock;
  target: MigrationTarget;
  provider: ProviderRecord;
  output: (line: string) => void;
  dataDirectory: string;
}

interface NeoVersion {
  major: number;
  minor: number;
}

interface SourceContainer {
  name: string;
  image: string;
  running: boolean;
  dataVolume: string;
  restartPolicy: string;
  boltHostPort: number | null;
}

type MigrationSource = { kind: 'container'; container: SourceContainer } | { kind: 'dump'; dumpDir: string };

interface MigrationRecord {
  containerName: string;
  restartPolicy: string | null;
  expectedSnapshot: GraphSnapshot | null;
}

const DEFAULT_SOURCE_USER = 'neo4j';
const DEFAULT_SOURCE_PASSWORD = 'PASSWORD';
const DUMP_FILE_NAME = 'neo4j.dump';
const MIGRATION_RECORD_FILE = 'migration.json';
const HOP_VERSION: NeoVersion = { major: 5, minor: 26 };
const HOP_IMAGE = 'neo4j:5.26';
const TOTAL_STEPS = 9;
const ROLLBACK_STEPS = 5;

class MigrationError extends Error {}

export const resolveDataDirectory = (env: NodeJS.ProcessEnv): string =>
  env.CGC_DATA_DIR ?? join(homedir(), '.local/share/code-graph-context');

export const parseNeoVersion = (text: string): NeoVersion | null => {
  const match = /(\d+)\.(\d+)/.exec(text);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
};

const compareVersions = (a: NeoVersion, b: NeoVersion): number => a.major - b.major || a.minor - b.minor;

const formatVersion = (version: NeoVersion): string => `${version.major}.${version.minor}`;

const imageTag = (image: string): string => {
  const afterRegistry = image.slice(image.lastIndexOf('/') + 1).split('@')[0];
  const colon = afterRegistry.indexOf(':');
  return colon === -1 ? '' : afterRegistry.slice(colon + 1);
};

export const formatDuration = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}m ${String(wholeSeconds % 60).padStart(2, '0')}s`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

export const parseContainerInspect = (inspectJson: string): SourceContainer => {
  const details = JSON.parse(inspectJson)[0];
  const dataMount = (details.Mounts ?? []).find((mount: { Destination: string }) => mount.Destination === '/data');
  if (!dataMount) {
    throw new MigrationError(`Container ${details.Name} has no volume mounted at /data`);
  }
  const policy = details.HostConfig?.RestartPolicy;
  const restartPolicy = !policy?.Name
    ? 'no'
    : policy.MaximumRetryCount
      ? `${policy.Name}:${policy.MaximumRetryCount}`
      : policy.Name;
  const hostPort = details.NetworkSettings?.Ports?.['7687/tcp']?.[0]?.HostPort;
  return {
    name: String(details.Name).replace(/^\//, ''),
    image: details.Config.Image,
    running: Boolean(details.State?.Running),
    dataVolume: dataMount.Type === 'bind' ? dataMount.Source : dataMount.Name,
    restartPolicy,
    boltHostPort: hostPort ? Number(hostPort) : null,
  };
};

/** Differences between the source graph and the target graph; empty when they match. */
export const compareSnapshots = (expected: GraphSnapshot, actual: GraphSnapshot): string[] => {
  const differences: string[] = [];
  if (expected.nodeCount !== actual.nodeCount) {
    differences.push(`nodes: expected ${expected.nodeCount}, found ${actual.nodeCount}`);
  }
  if (expected.relationshipCount !== actual.relationshipCount) {
    differences.push(`relationships: expected ${expected.relationshipCount}, found ${actual.relationshipCount}`);
  }
  for (const label of new Set([...Object.keys(expected.labelCounts), ...Object.keys(actual.labelCounts)])) {
    const want = expected.labelCounts[label] ?? 0;
    const have = actual.labelCounts[label] ?? 0;
    if (want !== have) differences.push(`label ${label}: expected ${want}, found ${have}`);
  }
  const describeIndex = (index: IndexDefinition): string =>
    `${index.type} on ${index.labelsOrTypes.join('|')}(${index.properties.join(',')})`;
  const actualByName = new Map(actual.indexes.map((index) => [index.name, index]));
  for (const index of expected.indexes) {
    const found = actualByName.get(index.name);
    if (!found) {
      differences.push(`index ${index.name} (${describeIndex(index)}) is missing`);
    } else if (describeIndex(found) !== describeIndex(index)) {
      differences.push(`index ${index.name}: expected ${describeIndex(index)}, found ${describeIndex(found)}`);
    }
  }
  const expectedNames = new Set(expected.indexes.map((index) => index.name));
  for (const index of actual.indexes) {
    if (!expectedNames.has(index.name)) differences.push(`index ${index.name} (${describeIndex(index)}) is unexpected`);
  }
  return differences;
};

export class DockerToNativeMigrationService {
  private readonly settings: MigrationSettings;

  constructor(
    private readonly dependencies: MigrationDependencies,
    settings: Partial<MigrationSettings> = {},
  ) {
    this.settings = { ...DEFAULT_MIGRATION_SETTINGS, ...settings };
  }

  async migrate(options: MigrateFromDockerOptions): Promise<MigrationStatus> {
    const migrationDir = join(this.migrationsRoot(), this.dependencies.clock.now().toISOString().replace(/[-:.]/g, ''));
    let sourceStopped = false;
    try {
      const source = await this.step(1, 'Check preconditions', () => this.checkPreconditions(options));
      const needsHop = await this.step(2, 'Resolve source version', () => this.resolveHopNeed(source));
      const expected = await this.step(3, 'Capture source counts', () => this.captureExpectedSnapshot(source));
      await this.step(4, 'Stop source container', async () => {
        await this.writeMigrationRecord(migrationDir, options, source, expected);
        sourceStopped = source.kind === 'container';
        await this.stopSource(source);
      });
      const sourceDump = await this.step(5, 'Dump source', () => this.dumpSource(source, migrationDir));
      const finalDump = await this.step(6, `Upgrade store through ${HOP_IMAGE}`, () =>
        this.hopThroughLts(source, needsHop, sourceDump, migrationDir),
      );
      await this.step(7, 'Load into target', () => this.loadIntoTarget(finalDump));
      const verification = await this.step(8, 'Verify target', () => this.verifyTarget(expected));
      if (verification.differences.length > 0) {
        this.reportVerificationFailure(verification.differences);
        return 'verification-failed';
      }
      await this.step(9, 'Switch provider to native', () => this.dependencies.provider.setProvider('native'));
      await this.reportSuccess(source, verification.snapshot, expected, finalDump);
      return 'completed';
    } catch (error) {
      this.dependencies.output(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      if (sourceStopped) {
        this.dependencies.output('The source container stays stopped and intact.');
        this.printRollbackHint();
      }
      return 'failed';
    }
  }

  async rollback(): Promise<MigrationStatus> {
    const { target, provider } = this.dependencies;
    try {
      const record = await this.step(
        1,
        'Find migration record',
        () => this.findLatestMigrationRecord(),
        ROLLBACK_STEPS,
      );
      await this.step(2, 'Stop target', () => target.stop(), ROLLBACK_STEPS);
      await this.step(3, 'Restore source restart policy', () => this.restoreRestartPolicy(record), ROLLBACK_STEPS);
      await this.step(4, 'Start source container', () => this.startSource(record.containerName), ROLLBACK_STEPS);
      await this.step(5, 'Switch provider to docker', () => provider.setProvider('docker'), ROLLBACK_STEPS);
      this.dependencies.output(`Rolled back: ${record.containerName} is running again and the provider is docker.`);
      return 'rolled-back';
    } catch (error) {
      this.dependencies.output(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
  }

  private migrationsRoot(): string {
    return join(this.dependencies.dataDirectory, 'migrations');
  }

  private async step<T>(number: number, title: string, work: () => Promise<T>, total = TOTAL_STEPS): Promise<T> {
    const { clock, output } = this.dependencies;
    const label = `[${number}/${total}] ${title}`;
    output(`${label} ...`);
    const startedAt = clock.now().getTime();
    const result = await work();
    output(`${label}: done in ${formatDuration(clock.now().getTime() - startedAt)}`);
    return result;
  }

  private async runChecked(file: string, args: string[]): Promise<CommandResult> {
    const result = await this.dependencies.commands.run(file, args);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' | ');
      throw new MigrationError(`${file} ${args.slice(0, 3).join(' ')} failed (exit ${result.exitCode}): ${detail}`);
    }
    return result;
  }

  private async checkPreconditions(options: MigrateFromDockerOptions): Promise<MigrationSource> {
    const { commands, files, target } = this.dependencies;
    let source: MigrationSource;
    if (options.fromDump) {
      if (!(await files.exists(join(options.fromDump, DUMP_FILE_NAME)))) {
        throw new MigrationError(`${join(options.fromDump, DUMP_FILE_NAME)} does not exist`);
      }
      source = { kind: 'dump', dumpDir: options.fromDump };
    } else {
      if ((await commands.run('docker', ['info'])).exitCode !== 0) {
        throw new MigrationError('Docker is not reachable; start Docker or pass --from-dump');
      }
      const inspected = await commands.run('docker', ['inspect', options.container]);
      if (inspected.exitCode !== 0) {
        throw new MigrationError(`Source container ${options.container} does not exist`);
      }
      source = { kind: 'container', container: parseContainerInspect(inspected.stdout) };
    }
    if (!(await target.isConfigured())) {
      throw new MigrationError(`${target.describe()} is not configured; run code-graph-context init first`);
    }
    if (!options.overwrite && (await target.hasData())) {
      throw new MigrationError(`${target.describe()} already has data; pass --overwrite to replace it`);
    }
    return source;
  }

  private async resolveHopNeed(source: MigrationSource): Promise<boolean> {
    if (source.kind === 'dump') {
      this.dependencies.output('  skipped: --from-dump must hold a 5.26 or newer dump');
      return false;
    }
    const { image } = source.container;
    const targetVersion = parseNeoVersion(await this.dependencies.target.neo4jVersion());
    if (!targetVersion) throw new MigrationError('Cannot read the target Neo4j version');
    const sourceVersion = parseNeoVersion(imageTag(image)) ?? (await this.readVersionFromImage(image));
    this.dependencies.output(`  source ${image} is Neo4j ${formatVersion(sourceVersion)}`);
    if (sourceVersion.major < HOP_VERSION.major) {
      throw new MigrationError(
        `Neo4j ${formatVersion(sourceVersion)} stores cannot be migrated; the oldest supported source is 5.x`,
      );
    }
    if (compareVersions(sourceVersion, targetVersion) > 0) {
      throw new MigrationError(
        `Source Neo4j ${formatVersion(sourceVersion)} is newer than the target ${formatVersion(targetVersion)}`,
      );
    }
    return compareVersions(sourceVersion, HOP_VERSION) < 0;
  }

  private async readVersionFromImage(image: string): Promise<NeoVersion> {
    const result = await this.runChecked('docker', ['run', '--rm', image, 'neo4j', '--version']);
    const version = parseNeoVersion(result.stdout);
    if (!version) throw new MigrationError(`Cannot read a version from "neo4j --version" in ${image}`);
    return version;
  }

  private sourceEndpoint(source: SourceContainer): BoltEndpoint {
    if (source.boltHostPort === null) {
      throw new MigrationError(`Container ${source.name} publishes no host port for Bolt (7687)`);
    }
    return {
      uri: `bolt://localhost:${source.boltHostPort}`,
      user: process.env.NEO4J_USER ?? DEFAULT_SOURCE_USER,
      password: process.env.NEO4J_PASSWORD ?? DEFAULT_SOURCE_PASSWORD,
    };
  }

  private async captureExpectedSnapshot(source: MigrationSource): Promise<GraphSnapshot | null> {
    const { bolt, files, output } = this.dependencies;
    if (source.kind === 'dump') {
      const recordPath = join(dirname(source.dumpDir), MIGRATION_RECORD_FILE);
      if (!(await files.exists(recordPath))) {
        output('  --from-dump has no recorded source counts, so verification checks indexes only');
        return null;
      }
      const record: MigrationRecord = JSON.parse(await files.readText(recordPath));
      output(`  using the source counts recorded in ${recordPath}`);
      return record.expectedSnapshot;
    }
    const { container } = source;
    if (!container.running) {
      output(`  ${container.name} is stopped, so no source counts exist; verification checks indexes only`);
      return null;
    }
    const snapshot = await bolt.captureGraphSnapshot(this.sourceEndpoint(container));
    output(
      `  ${snapshot.nodeCount} nodes, ${snapshot.relationshipCount} relationships, ` +
        `${Object.keys(snapshot.labelCounts).length} labels, ${snapshot.indexes.length} indexes`,
    );
    return snapshot;
  }

  private async writeMigrationRecord(
    migrationDir: string,
    options: MigrateFromDockerOptions,
    source: MigrationSource,
    expected: GraphSnapshot | null,
  ): Promise<void> {
    const { files } = this.dependencies;
    let restartPolicy: string | null = null;
    if (source.kind === 'container') {
      restartPolicy = source.container.restartPolicy;
    } else {
      const previousPath = join(dirname(source.dumpDir), MIGRATION_RECORD_FILE);
      if (await files.exists(previousPath)) {
        const previous: MigrationRecord = JSON.parse(await files.readText(previousPath));
        restartPolicy = previous.restartPolicy;
      }
    }
    const record: MigrationRecord = { containerName: options.container, restartPolicy, expectedSnapshot: expected };
    await files.makeDirectory(migrationDir);
    await files.writeText(join(migrationDir, MIGRATION_RECORD_FILE), JSON.stringify(record, null, 2));
  }

  private async stopSource(source: MigrationSource): Promise<void> {
    if (source.kind === 'dump') {
      this.dependencies.output('  skipped: --from-dump leaves the source container alone');
      return;
    }
    const { container } = source;
    await this.runChecked('docker', ['update', '--restart=no', container.name]);
    if (container.running) {
      await this.runChecked('docker', ['stop', '-t', String(this.settings.stopTimeoutSeconds), container.name]);
    }
  }

  private async dumpSource(source: MigrationSource, migrationDir: string): Promise<string> {
    if (source.kind === 'dump') {
      this.dependencies.output(`  skipped: using the dump in ${source.dumpDir}`);
      return source.dumpDir;
    }
    const dumpDir = join(migrationDir, 'dump-source');
    await this.dependencies.files.makeDirectory(dumpDir);
    await this.dumpVolume(source.container.image, source.container.dataVolume, dumpDir);
    return dumpDir;
  }

  private async dumpVolume(image: string, volume: string, dumpDir: string): Promise<void> {
    await this.runChecked('docker', [
      'run',
      '--rm',
      '-v',
      `${volume}:/data`,
      '-v',
      `${dumpDir}:/dumps`,
      image,
      'neo4j-admin',
      'database',
      'dump',
      'neo4j',
      '--to-path=/dumps',
    ]);
    if (!(await this.dependencies.files.exists(join(dumpDir, DUMP_FILE_NAME)))) {
      throw new MigrationError(`neo4j-admin reported success but ${join(dumpDir, DUMP_FILE_NAME)} does not exist`);
    }
  }

  private async hopThroughLts(
    source: MigrationSource,
    needsHop: boolean,
    sourceDump: string,
    migrationDir: string,
  ): Promise<string> {
    const { files, output } = this.dependencies;
    if (!needsHop) {
      output('  skipped: the dump is already 5.26 or newer');
      return sourceDump;
    }
    const container = `${this.settings.resourcePrefix}hop-${basename(migrationDir)}`;
    const volume = container;
    const upgradedDump = join(migrationDir, 'dump-5.26');
    await files.makeDirectory(upgradedDump);
    try {
      await this.runChecked('docker', ['volume', 'create', volume]);
      await this.runChecked('docker', [
        'run',
        '--rm',
        '-v',
        `${volume}:/data`,
        '-v',
        `${sourceDump}:/dumps`,
        HOP_IMAGE,
        'neo4j-admin',
        'database',
        'load',
        'neo4j',
        '--from-path=/dumps',
        '--overwrite-destination=true',
      ]);
      await this.runChecked('docker', [
        'run',
        '-d',
        '--name',
        container,
        '-v',
        `${volume}:/data`,
        '-e',
        'NEO4J_AUTH=none',
        HOP_IMAGE,
      ]);
      await this.waitForDatabaseOnline(container);
      await this.runChecked('docker', ['stop', '-t', String(this.settings.stopTimeoutSeconds), container]);
      await this.dumpVolume(HOP_IMAGE, volume, upgradedDump);
    } finally {
      await this.removeHopResources(container, volume);
    }
    return upgradedDump;
  }

  private async waitForDatabaseOnline(container: string): Promise<void> {
    const { commands, clock, output } = this.dependencies;
    const deadline = clock.now().getTime() + this.settings.bootWaitMs;
    while (clock.now().getTime() < deadline) {
      const running = await commands.run('docker', ['inspect', '--format={{.State.Running}}', container]);
      if (running.stdout.trim() !== 'true') {
        const logs = await commands.run('docker', ['logs', '--tail', '10', container]);
        throw new MigrationError(
          `${container} exited before the database came online: ${(logs.stdout + logs.stderr).trim()}`,
        );
      }
      const status = await commands.run('docker', [
        'exec',
        container,
        'cypher-shell',
        '--format',
        'plain',
        'SHOW DATABASE neo4j YIELD currentStatus RETURN currentStatus',
      ]);
      if (status.exitCode === 0 && /\bonline\b/.test(status.stdout)) return;
      output('  waiting for database neo4j to come online in the temporary 5.26 container');
      await clock.sleep(this.settings.pollIntervalMs);
    }
    throw new MigrationError(
      `Database neo4j did not come online in ${container} within ${formatDuration(this.settings.bootWaitMs)}`,
    );
  }

  private async removeHopResources(container: string, volume: string): Promise<void> {
    const { commands, output } = this.dependencies;
    if ((await commands.run('docker', ['rm', '-f', container])).exitCode !== 0) {
      output(`  could not remove temporary container ${container}; run: docker rm -f ${container}`);
    }
    if ((await commands.run('docker', ['volume', 'rm', volume])).exitCode !== 0) {
      output(`  could not remove temporary volume ${volume}; run: docker volume rm ${volume}`);
    }
  }

  private async loadIntoTarget(dumpDir: string): Promise<void> {
    const { target } = this.dependencies;
    await target.stop();
    await target.load(dumpDir);
    await target.start();
    await this.waitForBolt(target.connection, target.describe());
  }

  private async waitForBolt(endpoint: BoltEndpoint, description: string): Promise<void> {
    const { bolt, clock, output } = this.dependencies;
    const deadline = clock.now().getTime() + this.settings.bootWaitMs;
    while (!(await bolt.isReachable(endpoint))) {
      if (clock.now().getTime() >= deadline) {
        throw new MigrationError(
          `${description} did not answer on Bolt within ${formatDuration(this.settings.bootWaitMs)}`,
        );
      }
      output(`  waiting for ${description} to answer on Bolt`);
      await clock.sleep(this.settings.pollIntervalMs);
    }
  }

  private async verifyTarget(
    expected: GraphSnapshot | null,
  ): Promise<{ snapshot: GraphSnapshot; differences: string[] }> {
    const { bolt, target, clock, output } = this.dependencies;
    const deadline = clock.now().getTime() + this.settings.indexWaitMs;
    let snapshot = await bolt.captureGraphSnapshot(target.connection);
    for (;;) {
      const notOnline = snapshot.indexes.filter((index) => index.state !== 'ONLINE');
      if (
        notOnline.length === 0 ||
        notOnline.some((index) => index.state === 'FAILED') ||
        clock.now().getTime() >= deadline
      ) {
        break;
      }
      output(
        `  ${snapshot.indexes.length - notOnline.length} of ${snapshot.indexes.length} indexes ONLINE; waiting for ` +
          notOnline.map((index) => `${index.name} ${index.state} ${index.populationPercent.toFixed(1)}%`).join(', '),
      );
      await clock.sleep(this.settings.pollIntervalMs);
      snapshot = await bolt.captureGraphSnapshot(target.connection);
    }
    const differences = expected ? compareSnapshots(expected, snapshot) : [];
    for (const index of snapshot.indexes.filter((candidate) => candidate.state !== 'ONLINE')) {
      differences.push(`index ${index.name} is ${index.state}, expected ONLINE`);
    }
    return { snapshot, differences };
  }

  private reportVerificationFailure(differences: string[]): void {
    const { output } = this.dependencies;
    output(
      'Verification FAILED. The provider was not switched; the source container and volume were not modified or deleted.',
    );
    for (const difference of differences) output(`  - ${difference}`);
    this.printRollbackHint();
  }

  private printRollbackHint(): void {
    this.dependencies.output('To go back to Docker: code-graph-context migrate-from-docker --rollback');
  }

  private async reportSuccess(
    source: MigrationSource,
    snapshot: GraphSnapshot,
    expected: GraphSnapshot | null,
    finalDump: string,
  ): Promise<void> {
    const { files, output, target } = this.dependencies;
    const dumpSize = await files.sizeInBytes(finalDump);
    output('');
    output(`Migrated to ${target.describe()}.`);
    if (expected) {
      output(
        `  counts match: ${snapshot.nodeCount} nodes, ${snapshot.relationshipCount} relationships, ${Object.keys(snapshot.labelCounts).length} labels`,
      );
    } else {
      output(
        `  target holds ${snapshot.nodeCount} nodes and ${snapshot.relationshipCount} relationships (no source counts to compare)`,
      );
    }
    for (const index of snapshot.indexes) {
      output(`  index ${index.name} ${index.type} ${index.state}`);
    }
    output(`  dump kept at ${finalDump} (${formatBytes(dumpSize)})`);
    if (source.kind === 'container') {
      output(
        `  source container ${source.container.name} and volume ${source.container.dataVolume} are stopped and intact`,
      );
    }
    this.printRollbackHint();
  }

  private async findLatestMigrationRecord(): Promise<MigrationRecord> {
    const { files } = this.dependencies;
    const root = this.migrationsRoot();
    const names = (await files.exists(root)) ? (await files.listDirectories(root)).sort().reverse() : [];
    for (const name of names) {
      const recordPath = join(root, name, MIGRATION_RECORD_FILE);
      if (await files.exists(recordPath)) {
        this.dependencies.output(`  using ${recordPath}`);
        return JSON.parse(await files.readText(recordPath));
      }
    }
    throw new MigrationError(`No migration record found under ${root}`);
  }

  private async restoreRestartPolicy(record: MigrationRecord): Promise<void> {
    if (record.restartPolicy === null) {
      this.dependencies.output('  skipped: the migration did not change the restart policy');
      return;
    }
    await this.runChecked('docker', ['update', `--restart=${record.restartPolicy}`, record.containerName]);
  }

  private async startSource(containerName: string): Promise<void> {
    await this.runChecked('docker', ['start', containerName]);
    const inspected = await this.runChecked('docker', ['inspect', containerName]);
    await this.waitForBolt(this.sourceEndpoint(parseContainerInspect(inspected.stdout)), containerName);
  }
}

export const runMigrateFromDocker = async (
  options: MigrateFromDockerOptions,
  dependencies: MigrationDependencies,
): Promise<number> => {
  const service = new DockerToNativeMigrationService(dependencies);
  const status = options.rollback ? await service.rollback() : await service.migrate(options);
  return status === 'completed' || status === 'rolled-back' ? 0 : 1;
};
