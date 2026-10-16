import { beforeEach, describe, expect, it } from 'vitest';

import { Neo4jConnection } from '../../storage/neo4j/neo4j-connection.js';
import { CommandResult, CommandRunner } from '../command-runner.js';
import {
  BoltClient,
  Clock,
  DockerToNativeMigrationService,
  GraphSnapshot,
  IndexDefinition,
  MigrateFromDockerOptions,
  MigrationFileSystem,
  MigrationTarget,
  ProviderName,
  compareSnapshots,
  formatBytes,
  formatDuration,
  parseContainerInspect,
  parseNeoVersion,
} from '../migrate-from-docker.js';

const DATA_DIR = '/data/cgc';
const MIGRATION_DIR = `${DATA_DIR}/migrations/20261016T120000000Z`;
const SOURCE_DUMP = `${MIGRATION_DIR}/dump-source`;
const UPGRADED_DUMP = `${MIGRATION_DIR}/dump-5.26`;

const inspectJson = (
  overrides: {
    image?: string;
    running?: boolean;
    restart?: { Name: string; MaximumRetryCount: number };
    mounts?: object[];
    hostPort?: string;
  } = {},
): string =>
  JSON.stringify([
    {
      Name: '/code-graph-neo4j',
      Config: { Image: overrides.image ?? 'neo4j:5.23' },
      State: { Running: overrides.running ?? true },
      HostConfig: { RestartPolicy: overrides.restart ?? { Name: 'unless-stopped', MaximumRetryCount: 0 } },
      NetworkSettings: {
        Ports: {
          '7474/tcp': [{ HostIp: '0.0.0.0', HostPort: '7474' }],
          '7687/tcp': [{ HostIp: '0.0.0.0', HostPort: overrides.hostPort ?? '7687' }],
        },
      },
      Mounts: overrides.mounts ?? [
        {
          Type: 'volume',
          Name: 'code-graph-neo4j-data',
          Source: '/var/lib/docker/volumes/x/_data',
          Destination: '/data',
        },
        { Type: 'volume', Name: 'abc123', Source: '/var/lib/docker/volumes/y/_data', Destination: '/logs' },
      ],
    },
  ]);

const index = (name: string, overrides: Partial<IndexDefinition> = {}): IndexDefinition => ({
  name,
  type: 'RANGE',
  state: 'ONLINE',
  populationPercent: 100,
  labelsOrTypes: ['Embedded'],
  properties: ['projectId'],
  ...overrides,
});

const snapshot = (overrides: Partial<GraphSnapshot> = {}): GraphSnapshot => ({
  nodeCount: 210,
  relationshipCount: 269,
  labelCounts: { Embedded: 160, SessionNote: 30 },
  indexes: [index('project_embedded_idx'), index('embedded_nodes_idx', { type: 'VECTOR', properties: ['embedding'] })],
  ...overrides,
});

class ScriptedCommandRunner implements CommandRunner {
  readonly calls: string[] = [];
  private readonly scripted: { prefix: string; result: CommandResult }[] = [];

  constructor(private readonly onRun: (line: string) => void) {}

  script(prefix: string, result: Partial<CommandResult>): void {
    this.scripted.unshift({ prefix, result: { exitCode: 0, stdout: '', stderr: '', ...result } });
  }

  async run(file: string, args: string[]): Promise<CommandResult> {
    const line = [file, ...args].join(' ');
    this.calls.push(line);
    this.onRun(line);
    return (
      this.scripted.find((entry) => line.startsWith(entry.prefix))?.result ?? { exitCode: 0, stdout: '', stderr: '' }
    );
  }
}

class InMemoryFileSystem implements MigrationFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  async makeDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }
  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }
  async readText(path: string): Promise<string> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || [...this.directories].some((dir) => dir === path || dir.startsWith(`${path}/`));
  }
  async listDirectories(path: string): Promise<string[]> {
    return [...this.directories].filter((dir) => dir.startsWith(`${path}/`)).map((dir) => dir.slice(path.length + 1));
  }
  async sizeInBytes(): Promise<number> {
    return 3 * 1024 * 1024;
  }
}

class FakeClock implements Clock {
  private current = Date.parse('2026-10-16T12:00:00.000Z');
  now(): Date {
    return new Date(this.current);
  }
  async sleep(ms: number): Promise<void> {
    this.current += ms;
  }
}

class FakeBolt implements BoltClient {
  readonly sourceEndpoints: Neo4jConnection[] = [];
  sourceSnapshot = snapshot();
  targetSnapshots: GraphSnapshot[] = [snapshot()];
  reachableAfterAttempts = 0;
  private reachableAttempts = 0;
  private targetReads = 0;

  async isReachable(): Promise<boolean> {
    this.reachableAttempts += 1;
    return this.reachableAttempts > this.reachableAfterAttempts;
  }

  async captureGraphSnapshot(endpoint: Neo4jConnection): Promise<GraphSnapshot> {
    if (endpoint.uri.endsWith(':27687')) {
      const read = this.targetSnapshots[Math.min(this.targetReads, this.targetSnapshots.length - 1)];
      this.targetReads += 1;
      return read;
    }
    this.sourceEndpoints.push(endpoint);
    return this.sourceSnapshot;
  }
}

class FakeTarget implements MigrationTarget {
  readonly connection: Neo4jConnection = { uri: 'bolt://localhost:27687', user: 'neo4j', password: 'PASSWORD' };
  configured = true;
  data = false;
  version = '2026.02.2';

  constructor(private readonly events: string[]) {}

  describe(): string {
    return 'native Neo4j';
  }
  async neo4jVersion(): Promise<string> {
    return this.version;
  }
  async isConfigured(): Promise<boolean> {
    return this.configured;
  }
  async hasData(): Promise<boolean> {
    return this.data;
  }
  async stop(): Promise<void> {
    this.events.push('target.stop');
  }
  async load(dumpDir: string): Promise<void> {
    this.events.push(`target.load ${dumpDir}`);
  }
  async start(): Promise<void> {
    this.events.push('target.start');
  }
}

interface Harness {
  service: DockerToNativeMigrationService;
  commands: ScriptedCommandRunner;
  bolt: FakeBolt;
  files: InMemoryFileSystem;
  target: FakeTarget;
  events: string[];
  providers: ProviderName[];
  output: string[];
  behavior: { writeDumpFiles: boolean };
}

const buildHarness = (): Harness => {
  const events: string[] = [];
  const output: string[] = [];
  const providers: ProviderName[] = [];
  const behavior = { writeDumpFiles: true };
  const files = new InMemoryFileSystem();
  const commands = new ScriptedCommandRunner((line) => {
    const dumpMount = / -v ([^ ]+):\/dumps /.exec(line);
    if (behavior.writeDumpFiles && dumpMount && line.includes('neo4j-admin database dump'))
      files.files.set(`${dumpMount[1]}/neo4j.dump`, 'dump');
  });
  commands.script('docker inspect code-graph-neo4j', { stdout: inspectJson() });
  commands.script('docker inspect --format={{.State.Running}}', { stdout: 'true\n' });
  commands.script('docker exec', { stdout: 'currentStatus\n"online"\n' });
  const bolt = new FakeBolt();
  const target = new FakeTarget(events);
  const service = new DockerToNativeMigrationService(
    {
      commands,
      bolt,
      files,
      clock: new FakeClock(),
      target,
      provider: { setProvider: async (provider) => void providers.push(provider) },
      output: (line) => output.push(line),
      dataDirectory: DATA_DIR,
    },
    { resourcePrefix: 'cgc-migrate-test-', pollIntervalMs: 1000, indexWaitMs: 5000, bootWaitMs: 5000 },
  );
  return { service, commands, bolt, files, target, events, providers, output, behavior };
};

const options = (overrides: Partial<MigrateFromDockerOptions> = {}): MigrateFromDockerOptions => ({
  container: 'code-graph-neo4j',
  ...overrides,
});

let h: Harness;
beforeEach(() => {
  h = buildHarness();
});

describe('parseNeoVersion', () => {
  it('reads major and minor from tags and command output', () => {
    expect(parseNeoVersion('5.23')).toEqual({ major: 5, minor: 23 });
    expect(parseNeoVersion('5.26.1-community')).toEqual({ major: 5, minor: 26 });
    expect(parseNeoVersion('neo4j 2026.02.2')).toEqual({ major: 2026, minor: 2 });
  });

  it('returns null when there is no minor version', () => {
    expect(parseNeoVersion('latest')).toBeNull();
    expect(parseNeoVersion('5')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats durations and sizes', () => {
    expect(formatDuration(3200)).toBe('3.2s');
    expect(formatDuration(125000)).toBe('2m 05s');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
    expect(formatBytes(512)).toBe('0.5 KiB');
  });
});

describe('parseContainerInspect', () => {
  it('reads image, data volume, restart policy and host Bolt port', () => {
    expect(parseContainerInspect(inspectJson({ hostPort: '17687' }))).toEqual({
      name: 'code-graph-neo4j',
      image: 'neo4j:5.23',
      running: true,
      dataVolume: 'code-graph-neo4j-data',
      restartPolicy: 'unless-stopped',
      boltHostPort: 17687,
    });
  });

  it('keeps the retry count of on-failure and maps an empty policy to no', () => {
    expect(
      parseContainerInspect(inspectJson({ restart: { Name: 'on-failure', MaximumRetryCount: 3 } })).restartPolicy,
    ).toBe('on-failure:3');
    expect(parseContainerInspect(inspectJson({ restart: { Name: '', MaximumRetryCount: 0 } })).restartPolicy).toBe(
      'no',
    );
  });

  it('uses the host path for a bind mount', () => {
    const mounts = [{ Type: 'bind', Source: '/srv/neo4j', Destination: '/data' }];
    expect(parseContainerInspect(inspectJson({ mounts })).dataVolume).toBe('/srv/neo4j');
  });

  it('rejects a container without a /data mount', () => {
    expect(() => parseContainerInspect(inspectJson({ mounts: [] }))).toThrow('has no volume mounted at /data');
  });
});

describe('compareSnapshots', () => {
  it('returns nothing for equal snapshots', () => {
    expect(compareSnapshots(snapshot(), snapshot())).toEqual([]);
  });

  it('reports node, relationship and label differences', () => {
    const actual = snapshot({
      nodeCount: 209,
      relationshipCount: 270,
      labelCounts: { Embedded: 159, SessionNote: 30, Stray: 1 },
    });
    expect(compareSnapshots(snapshot(), actual)).toEqual([
      'nodes: expected 210, found 209',
      'relationships: expected 269, found 270',
      'label Embedded: expected 160, found 159',
      'label Stray: expected 0, found 1',
    ]);
  });

  it('reports missing, changed and unexpected indexes', () => {
    const actual = snapshot({
      indexes: [index('embedded_nodes_idx', { type: 'VECTOR', properties: ['other'] }), index('extra_idx')],
    });
    expect(compareSnapshots(snapshot(), actual)).toEqual([
      'index project_embedded_idx (RANGE on Embedded(projectId)) is missing',
      'index embedded_nodes_idx: expected VECTOR on Embedded(embedding), found VECTOR on Embedded(other)',
      'index extra_idx (RANGE on Embedded(projectId)) is unexpected',
    ]);
  });
});

describe('migrate from a 5.23 container', () => {
  it('runs the steps in order, hops through 5.26 and switches the provider', async () => {
    const status = await h.service.migrate(options());

    expect(status).toBe('completed');
    expect(h.commands.calls).toEqual([
      'docker info',
      'docker inspect code-graph-neo4j',
      'docker update --restart=no code-graph-neo4j',
      'docker stop -t 300 code-graph-neo4j',
      `docker run --rm -v code-graph-neo4j-data:/data -v ${SOURCE_DUMP}:/dumps neo4j:5.23 neo4j-admin database dump neo4j --to-path=/dumps`,
      'docker volume create cgc-migrate-test-hop-20261016T120000000Z',
      `docker run --rm -v cgc-migrate-test-hop-20261016T120000000Z:/data -v ${SOURCE_DUMP}:/dumps neo4j:5.26 neo4j-admin database load neo4j --from-path=/dumps --overwrite-destination=true`,
      'docker run -d --name cgc-migrate-test-hop-20261016T120000000Z -v cgc-migrate-test-hop-20261016T120000000Z:/data -e NEO4J_AUTH=none neo4j:5.26',
      'docker inspect --format={{.State.Running}} cgc-migrate-test-hop-20261016T120000000Z',
      'docker exec cgc-migrate-test-hop-20261016T120000000Z cypher-shell --format plain SHOW DATABASE neo4j YIELD currentStatus RETURN currentStatus',
      'docker stop -t 300 cgc-migrate-test-hop-20261016T120000000Z',
      `docker run --rm -v cgc-migrate-test-hop-20261016T120000000Z:/data -v ${UPGRADED_DUMP}:/dumps neo4j:5.26 neo4j-admin database dump neo4j --to-path=/dumps`,
      'docker rm -f cgc-migrate-test-hop-20261016T120000000Z',
      'docker volume rm cgc-migrate-test-hop-20261016T120000000Z',
    ]);
    expect(h.events).toEqual(['target.stop', `target.load ${UPGRADED_DUMP}`, 'target.start']);
    expect(h.providers).toEqual(['native']);
    expect(h.bolt.sourceEndpoints).toEqual([{ uri: 'bolt://localhost:7687', user: 'neo4j', password: 'PASSWORD' }]);
  });

  it('records the old restart policy and the expected counts before stopping the source', async () => {
    await h.service.migrate(options());

    expect(JSON.parse(h.files.files.get(`${MIGRATION_DIR}/migration.json`) ?? '')).toEqual({
      containerName: 'code-graph-neo4j',
      restartPolicy: 'unless-stopped',
      expectedSnapshot: snapshot(),
    });
  });

  it('prints a line with elapsed time for each of the nine steps and a report', async () => {
    await h.service.migrate(options());

    const finished = h.output.filter((line) => /^\[\d\/9\].*: done in 0\.0s$/.test(line));
    expect(finished).toHaveLength(9);
    expect(h.output).toContain('  counts match: 210 nodes, 269 relationships, 2 labels');
    expect(h.output).toContain(`  dump kept at ${UPGRADED_DUMP} (3.0 MiB)`);
    expect(h.output).toContain(
      '  source container code-graph-neo4j and volume code-graph-neo4j-data are stopped and intact',
    );
    expect(h.output).toContain('To go back to Docker: code-graph-context migrate-from-docker --rollback');
  });

  it('never removes the source container or its volume', async () => {
    await h.service.migrate(options());

    expect(h.commands.calls.filter((line) => /^docker (rm|volume rm)\b.*code-graph-neo4j/.test(line))).toEqual([]);
  });

  it('uses NEO4J_USER and NEO4J_PASSWORD for the source Bolt connection', async () => {
    process.env.NEO4J_USER = 'admin';
    process.env.NEO4J_PASSWORD = 'secret';
    try {
      await h.service.migrate(options());
    } finally {
      delete process.env.NEO4J_USER;
      delete process.env.NEO4J_PASSWORD;
    }

    expect(h.bolt.sourceEndpoints[0]).toEqual({ uri: 'bolt://localhost:7687', user: 'admin', password: 'secret' });
  });
});

describe('source version and the hop decision', () => {
  it('skips the hop for a 5.26 source and loads the first dump', async () => {
    h.commands.script('docker inspect code-graph-neo4j', { stdout: inspectJson({ image: 'neo4j:5.26.1-community' }) });

    await h.service.migrate(options());

    expect(h.commands.calls.some((line) => line.includes('volume create'))).toBe(false);
    expect(h.events).toContain(`target.load ${SOURCE_DUMP}`);
  });

  it('asks the image for its version when the tag has none', async () => {
    h.commands.script('docker inspect code-graph-neo4j', { stdout: inspectJson({ image: 'neo4j:latest' }) });
    h.commands.script('docker run --rm neo4j:latest neo4j --version', { stdout: 'neo4j 5.23.0\n' });

    await h.service.migrate(options());

    expect(h.commands.calls).toContain('docker run --rm neo4j:latest neo4j --version');
    expect(h.events).toContain(`target.load ${UPGRADED_DUMP}`);
  });

  it('ignores a registry port when reading the tag', async () => {
    h.commands.script('docker inspect code-graph-neo4j', {
      stdout: inspectJson({ image: 'registry:5000/neo4j:5.26' }),
    });

    await h.service.migrate(options());

    expect(h.events).toContain(`target.load ${SOURCE_DUMP}`);
  });

  it('refuses a 4.x source before stopping anything', async () => {
    h.commands.script('docker inspect code-graph-neo4j', { stdout: inspectJson({ image: 'neo4j:4.4' }) });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: Neo4j 4.4 stores cannot be migrated; the oldest supported source is 5.x');
    expect(h.commands.calls.some((line) => line.startsWith('docker stop'))).toBe(false);
  });

  it('refuses a source newer than the target', async () => {
    h.commands.script('docker inspect code-graph-neo4j', { stdout: inspectJson({ image: 'neo4j:2026.09' }) });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: Source Neo4j 2026.9 is newer than the target 2026.2');
  });
});

describe('preconditions', () => {
  it('fails when Docker is not reachable', async () => {
    h.commands.script('docker info', { exitCode: 1 });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: Docker is not reachable; start Docker or pass --from-dump');
  });

  it('fails when the source container does not exist', async () => {
    h.commands.script('docker inspect code-graph-neo4j', { exitCode: 1 });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: Source container code-graph-neo4j does not exist');
  });

  it('fails when the target is not configured', async () => {
    h.target.configured = false;

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: native Neo4j is not configured; run code-graph-context init first');
  });

  it('fails when the target has data and --overwrite is absent', async () => {
    h.target.data = true;

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: native Neo4j already has data; pass --overwrite to replace it');
    expect(h.commands.calls.some((line) => line.startsWith('docker stop'))).toBe(false);
  });

  it('replaces a target that has data when --overwrite is given', async () => {
    h.target.data = true;

    expect(await h.service.migrate(options({ overwrite: true }))).toBe('completed');
  });
});

describe('source counts', () => {
  it('verifies indexes only when the source is stopped', async () => {
    h.commands.script('docker inspect code-graph-neo4j', { stdout: inspectJson({ running: false }) });
    h.bolt.targetSnapshots = [snapshot({ nodeCount: 1 })];

    expect(await h.service.migrate(options())).toBe('completed');

    expect(h.bolt.sourceEndpoints).toEqual([]);
    expect(h.commands.calls.some((line) => line.startsWith('docker stop -t 300 code-graph-neo4j'))).toBe(false);
    expect(h.output).toContain(
      '  code-graph-neo4j is stopped, so no source counts exist; verification checks indexes only',
    );
    expect(h.output).toContain('  target holds 1 nodes and 269 relationships (no source counts to compare)');
  });
});

describe('verification', () => {
  it('waits while an index populates and shows its progress', async () => {
    const populating = snapshot({
      indexes: [
        index('project_embedded_idx'),
        index('embedded_nodes_idx', {
          type: 'VECTOR',
          properties: ['embedding'],
          state: 'POPULATING',
          populationPercent: 42.5,
        }),
      ],
    });
    h.bolt.targetSnapshots = [populating, snapshot()];

    expect(await h.service.migrate(options())).toBe('completed');

    expect(h.output).toContain('  1 of 2 indexes ONLINE; waiting for embedded_nodes_idx POPULATING 42.5%');
  });

  it('reports every difference, keeps the provider and prints the rollback command', async () => {
    h.bolt.targetSnapshots = [snapshot({ nodeCount: 200, labelCounts: { Embedded: 150, SessionNote: 30 } })];

    expect(await h.service.migrate(options())).toBe('verification-failed');

    expect(h.providers).toEqual([]);
    expect(h.output).toContain('  - nodes: expected 210, found 200');
    expect(h.output).toContain('  - label Embedded: expected 160, found 150');
    expect(h.output).toContain('To go back to Docker: code-graph-context migrate-from-docker --rollback');
    expect(h.commands.calls.some((line) => /^docker (rm|volume rm)\b.*code-graph-neo4j/.test(line))).toBe(false);
  });

  it('fails at once on a FAILED index instead of waiting out the deadline', async () => {
    h.bolt.targetSnapshots = [
      snapshot({
        indexes: [index('project_embedded_idx', { state: 'FAILED', populationPercent: 0 }), snapshot().indexes[1]],
      }),
    ];

    expect(await h.service.migrate(options())).toBe('verification-failed');

    expect(h.output).toContain('  - index project_embedded_idx is FAILED, expected ONLINE');
    expect(h.output.some((line) => line.includes('waiting for project_embedded_idx'))).toBe(false);
  });

  it('fails when an index is still populating at the deadline', async () => {
    h.bolt.targetSnapshots = [
      snapshot({
        indexes: [index('project_embedded_idx', { state: 'POPULATING', populationPercent: 10 }), snapshot().indexes[1]],
      }),
    ];

    expect(await h.service.migrate(options())).toBe('verification-failed');

    expect(h.output).toContain('  - index project_embedded_idx is POPULATING, expected ONLINE');
  });

  it('waits for Bolt on the target before reading it', async () => {
    h.bolt.reachableAfterAttempts = 2;

    expect(await h.service.migrate(options())).toBe('completed');

    expect(h.output.filter((line) => line === '  waiting for native Neo4j to answer on Bolt')).toHaveLength(2);
  });
});

describe('failures after the source is stopped', () => {
  it('prints the rollback command when the dump fails', async () => {
    h.commands.script('docker run --rm -v code-graph-neo4j-data:/data', { exitCode: 1, stderr: 'disk full' });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain('FAILED: docker run --rm -v failed (exit 1): disk full');
    expect(h.output).toContain('The source container stays stopped and intact.');
    expect(h.output).toContain('To go back to Docker: code-graph-context migrate-from-docker --rollback');
    expect(h.events).toEqual([]);
    expect(h.providers).toEqual([]);
  });

  it('removes the temporary 5.26 container and volume when the hop fails', async () => {
    h.commands.script('docker run -d --name cgc-migrate-test-hop', { exitCode: 1, stderr: 'no space' });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.commands.calls.slice(-2)).toEqual([
      'docker rm -f cgc-migrate-test-hop-20261016T120000000Z',
      'docker volume rm cgc-migrate-test-hop-20261016T120000000Z',
    ]);
    expect(h.events).toEqual([]);
  });

  it('names the leftover temporary resources when cleanup fails', async () => {
    h.commands.script('docker run -d --name cgc-migrate-test-hop', { exitCode: 1, stderr: 'no space' });
    h.commands.script('docker volume rm', { exitCode: 1 });

    await h.service.migrate(options());

    expect(h.output).toContain(
      '  could not remove temporary volume cgc-migrate-test-hop-20261016T120000000Z; run: docker volume rm cgc-migrate-test-hop-20261016T120000000Z',
    );
  });

  it('fails when the temporary 5.26 container exits before the database is online', async () => {
    h.commands.script('docker inspect --format={{.State.Running}}', { stdout: 'false\n' });
    h.commands.script('docker logs', { stdout: 'Store needs recovery' });

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain(
      'FAILED: cgc-migrate-test-hop-20261016T120000000Z exited before the database came online: Store needs recovery',
    );
  });

  it('fails when neo4j-admin reports success but writes no dump file', async () => {
    h.behavior.writeDumpFiles = false;

    expect(await h.service.migrate(options())).toBe('failed');

    expect(h.output).toContain(`FAILED: neo4j-admin reported success but ${SOURCE_DUMP}/neo4j.dump does not exist`);
  });
});

describe('--from-dump', () => {
  const FROM = '/old/migrations/20261001T000000000Z/dump-5.26';

  it('loads the given dump without touching Docker and uses the recorded counts', async () => {
    h.files.files.set(`${FROM}/neo4j.dump`, 'dump');
    h.files.files.set(
      '/old/migrations/20261001T000000000Z/migration.json',
      JSON.stringify({
        containerName: 'code-graph-neo4j',
        restartPolicy: 'unless-stopped',
        expectedSnapshot: snapshot(),
      }),
    );
    h.bolt.targetSnapshots = [snapshot({ nodeCount: 5 })];

    expect(await h.service.migrate(options({ fromDump: FROM }))).toBe('verification-failed');

    expect(h.commands.calls).toEqual([]);
    expect(h.events).toEqual(['target.stop', `target.load ${FROM}`, 'target.start']);
    expect(h.output).toContain('  - nodes: expected 210, found 5');
    expect(JSON.parse(h.files.files.get(`${MIGRATION_DIR}/migration.json`) ?? '').restartPolicy).toBe('unless-stopped');
  });

  it('verifies indexes only when no record sits beside the dump', async () => {
    h.files.files.set(`${FROM}/neo4j.dump`, 'dump');

    expect(await h.service.migrate(options({ fromDump: FROM }))).toBe('completed');

    expect(h.output).toContain('  --from-dump has no recorded source counts, so verification checks indexes only');
    expect(JSON.parse(h.files.files.get(`${MIGRATION_DIR}/migration.json`) ?? '').restartPolicy).toBeNull();
  });

  it('fails when the directory holds no neo4j.dump', async () => {
    expect(await h.service.migrate(options({ fromDump: FROM }))).toBe('failed');

    expect(h.output).toContain(`FAILED: ${FROM}/neo4j.dump does not exist`);
  });
});

describe('rollback', () => {
  const OLDER = `${DATA_DIR}/migrations/20261001T000000000Z`;

  const writeRecord = (dir: string, restartPolicy: string | null): void => {
    h.files.directories.add(dir);
    h.files.files.set(
      `${dir}/migration.json`,
      JSON.stringify({ containerName: 'code-graph-neo4j', restartPolicy, expectedSnapshot: null }),
    );
  };

  it('stops the target, restores the restart policy, starts the source and switches to docker', async () => {
    writeRecord(OLDER, 'always');
    writeRecord(MIGRATION_DIR, 'unless-stopped');

    expect(await h.service.rollback()).toBe('rolled-back');

    expect(h.events).toEqual(['target.stop']);
    expect(h.commands.calls).toEqual([
      'docker update --restart=unless-stopped code-graph-neo4j',
      'docker start code-graph-neo4j',
      'docker inspect code-graph-neo4j',
    ]);
    expect(h.providers).toEqual(['docker']);
    expect(h.output).toContain('Rolled back: code-graph-neo4j is running again and the provider is docker.');
  });

  it('leaves the restart policy alone when the migration recorded none', async () => {
    writeRecord(MIGRATION_DIR, null);

    expect(await h.service.rollback()).toBe('rolled-back');

    expect(h.commands.calls.some((line) => line.startsWith('docker update'))).toBe(false);
  });

  it('waits for the source to answer on Bolt before switching the provider', async () => {
    writeRecord(MIGRATION_DIR, 'unless-stopped');
    h.bolt.reachableAfterAttempts = 1;

    await h.service.rollback();

    expect(h.output).toContain('  waiting for code-graph-neo4j to answer on Bolt');
    expect(h.providers).toEqual(['docker']);
  });

  it('fails when no migration record exists', async () => {
    expect(await h.service.rollback()).toBe('failed');

    expect(h.output).toContain(`FAILED: No migration record found under ${DATA_DIR}/migrations`);
    expect(h.providers).toEqual([]);
  });

  it('keeps the provider when docker start fails', async () => {
    writeRecord(MIGRATION_DIR, 'unless-stopped');
    h.commands.script('docker start', { exitCode: 1, stderr: 'port is already allocated' });

    expect(await h.service.rollback()).toBe('failed');

    expect(h.providers).toEqual([]);
  });
});
