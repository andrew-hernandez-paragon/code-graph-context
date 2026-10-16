/**
 * Native Neo4j provider: runs Homebrew's Neo4j under a launchd agent that owns its own
 * conf, plugins and data, so `brew upgrade` (which replaces libexec) never touches them.
 */

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { CommandResult, CommandRunner, ProcessCommandRunner } from './command-runner.js';
import {
  ManagedConfSettings,
  NativeNeo4jPaths,
  renderLaunchdPlist,
  renderNeo4jConf,
  resolveNativePaths,
} from './neo4j-native-files.js';

export const DEFAULT_LAUNCHD_LABEL = 'dev.code-graph-context.neo4j';

const NEO4J_FORMULA = 'neo4j';
const APOC_CORE_JAR = /^apoc-.*-core\.jar$/;
const APOC_JAR = /^apoc-.*\.jar$/;
const NEO4J_CONF_FILE = 'neo4j.conf';
const UNLOAD_POLL_ATTEMPTS = 120;
const UNLOAD_POLL_INTERVAL_MS = 250;

export interface NativeFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  removeFile(path: string): Promise<void>;
}

export interface NativeNeo4jConfigureOptions {
  boltPort: number;
  httpPort: number;
  password: string;
  heapMax: string;
  pagecache: string;
}

export interface NativeNeo4jSettings {
  paths: NativeNeo4jPaths;
  launchdLabel: string;
  launchAgentsDir: string;
  uid: number;
}

export class NodeNativeFileSystem implements NativeFileSystem {
  async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  readFile(path: string): Promise<string> {
    return readFile(path, 'utf-8');
  }

  writeFile(path: string, content: string): Promise<void> {
    return writeFile(path, content);
  }

  async makeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  copyFile(source: string, destination: string): Promise<void> {
    return copyFile(source, destination);
  }

  listDirectory(path: string): Promise<string[]> {
    return readdir(path);
  }

  removeFile(path: string): Promise<void> {
    return rm(path, { force: true });
  }
}

export const resolveNativeSettings = (): NativeNeo4jSettings => ({
  paths: resolveNativePaths(
    process.env.CGC_NEO4J_HOME ?? join(homedir(), '.local', 'share', 'code-graph-context', 'neo4j'),
  ),
  launchdLabel: process.env.CGC_NEO4J_LAUNCHD_LABEL ?? DEFAULT_LAUNCHD_LABEL,
  launchAgentsDir: join(homedir(), 'Library', 'LaunchAgents'),
  uid: process.getuid?.() ?? 0,
});

export class NativeNeo4jProvider {
  private brewPrefix: Promise<string | null> | null = null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly fileSystem: NativeFileSystem,
    private readonly settings: NativeNeo4jSettings,
  ) {}

  get paths(): NativeNeo4jPaths {
    return this.settings.paths;
  }

  get plistPath(): string {
    return join(this.settings.launchAgentsDir, `${this.settings.launchdLabel}.plist`);
  }

  private get serviceTarget(): string {
    return `gui/${this.settings.uid}/${this.settings.launchdLabel}`;
  }

  async isBrewAvailable(): Promise<boolean> {
    return (await this.runner.run('brew', ['--version'])).exitCode === 0;
  }

  async isInstalled(): Promise<boolean> {
    const prefix = await this.findBrewPrefix();
    return prefix !== null && (await this.fileSystem.exists(join(prefix, 'bin', 'neo4j')));
  }

  async install(): Promise<CommandResult> {
    const result = await this.runner.run('brew', ['install', NEO4J_FORMULA]);
    this.brewPrefix = null;
    return result;
  }

  async isBrewServiceStarted(): Promise<boolean> {
    const result = await this.runner.run('brew', ['services', 'list']);
    return result.stdout.split('\n').some((line) => /^neo4j\s+started\b/.test(line));
  }

  async isConfigured(): Promise<boolean> {
    return (
      (await this.fileSystem.exists(join(this.paths.conf, NEO4J_CONF_FILE))) &&
      (await this.fileSystem.exists(this.plistPath))
    );
  }

  async hasData(): Promise<boolean> {
    return this.fileSystem.exists(join(this.paths.data, 'databases', 'neo4j'));
  }

  async neo4jVersion(): Promise<string | null> {
    const prefix = await this.requireBrewPrefix();
    const result = await this.runner.run(join(prefix, 'bin', 'neo4j'), ['--version']);
    return result.exitCode === 0 ? result.stdout.trim().replace(/^neo4j\s+/i, '') : null;
  }

  async runAdmin(args: string[]): Promise<CommandResult> {
    const prefix = await this.requireBrewPrefix();
    return this.runner.run(join(prefix, 'bin', 'neo4j-admin'), args, { env: { NEO4J_CONF: this.paths.conf } });
  }

  /** Writes conf, APOC, the initial password and the launchd plist. Rerunning gives the same files; it never starts Neo4j. */
  async configure(options: NativeNeo4jConfigureOptions): Promise<void> {
    const prefix = await this.requireBrewPrefix();
    const stockConfDir = join(prefix, 'libexec', 'conf');
    for (const directory of [
      this.paths.conf,
      this.paths.data,
      this.paths.logs,
      this.paths.plugins,
      this.paths.run,
      this.paths.import,
      this.settings.launchAgentsDir,
    ]) {
      await this.fileSystem.makeDirectory(directory);
    }

    await this.writeConf(stockConfDir, options);
    await this.replaceApoc(join(prefix, 'libexec', 'labs'));
    await this.setInitialPassword(options.password);
    await this.fileSystem.writeFile(
      this.plistPath,
      renderLaunchdPlist({
        label: this.settings.launchdLabel,
        neo4jBin: join(prefix, 'bin', 'neo4j'),
        confDir: this.paths.conf,
        logPath: join(this.paths.logs, 'launchd.log'),
      }),
    );
  }

  async isServiceLoaded(): Promise<boolean> {
    return (await this.runner.run('launchctl', ['print', this.serviceTarget])).exitCode === 0;
  }

  /** Never uses `kickstart -k`: many MCP servers may call this at once and must not restart each other's Neo4j. */
  async startService(): Promise<void> {
    // A disabled agent refuses bootstrap, and init or a rollback may have disabled it.
    await this.expectSuccess(await this.runner.run('launchctl', ['enable', this.serviceTarget]), 'enable');
    if (await this.isServiceLoaded()) {
      await this.expectSuccess(await this.runner.run('launchctl', ['kickstart', this.serviceTarget]), 'kickstart');
      return;
    }
    const result = await this.runner.run('launchctl', ['bootstrap', `gui/${this.settings.uid}`, this.plistPath]);
    // A concurrent caller may have bootstrapped between the check and the call.
    if (result.exitCode !== 0 && !(await this.isServiceLoaded())) {
      await this.expectSuccess(result, 'bootstrap');
    }
  }

  /** Keeps launchd from starting Neo4j at login while another Neo4j (the Docker graph) owns the ports. */
  async disableService(): Promise<void> {
    await this.expectSuccess(await this.runner.run('launchctl', ['disable', this.serviceTarget]), 'disable');
  }

  async stopService(): Promise<void> {
    if (!(await this.isServiceLoaded())) return;
    const result = await this.runner.run('launchctl', ['bootout', this.serviceTarget]);
    if (result.exitCode !== 0 && (await this.isServiceLoaded())) {
      await this.expectSuccess(result, 'bootout');
    }
    await this.waitUntilUnloaded();
  }

  // launchd keeps reporting the job while Neo4j shuts down; a start in that window would kickstart a dying job.
  private async waitUntilUnloaded(): Promise<void> {
    for (let attempt = 0; attempt < UNLOAD_POLL_ATTEMPTS && (await this.isServiceLoaded()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, UNLOAD_POLL_INTERVAL_MS));
    }
  }

  private async expectSuccess(result: CommandResult, action: string): Promise<void> {
    if (result.exitCode !== 0) {
      throw new Error(`launchctl ${action} ${this.settings.launchdLabel} failed: ${result.stderr.trim()}`);
    }
  }

  private async writeConf(stockConfDir: string, options: NativeNeo4jConfigureOptions): Promise<void> {
    const settings: ManagedConfSettings = { paths: this.paths, ...options };
    const stockConf = await this.fileSystem.readFile(join(stockConfDir, NEO4J_CONF_FILE));
    await this.fileSystem.writeFile(join(this.paths.conf, NEO4J_CONF_FILE), renderNeo4jConf(stockConf, settings));
    // The rest of the stock conf dir (neo4j-admin.conf, the log4j xml files) is copied unchanged.
    for (const name of await this.fileSystem.listDirectory(stockConfDir)) {
      if (name !== NEO4J_CONF_FILE) {
        await this.fileSystem.copyFile(join(stockConfDir, name), join(this.paths.conf, name));
      }
    }
  }

  private async replaceApoc(labsDir: string): Promise<void> {
    const jar = (await this.fileSystem.listDirectory(labsDir)).find((name) => APOC_CORE_JAR.test(name));
    if (!jar) throw new Error(`No APOC core jar in ${labsDir}`);
    for (const name of await this.fileSystem.listDirectory(this.paths.plugins)) {
      if (APOC_JAR.test(name)) await this.fileSystem.removeFile(join(this.paths.plugins, name));
    }
    await this.fileSystem.copyFile(join(labsDir, jar), join(this.paths.plugins, jar));
  }

  // Neo4j applies the initial password only before the system database exists.
  private async setInitialPassword(password: string): Promise<void> {
    if (await this.fileSystem.exists(join(this.paths.data, 'databases', 'system'))) return;
    const result = await this.runAdmin(['dbms', 'set-initial-password', password]);
    if (result.exitCode !== 0) {
      throw new Error(`neo4j-admin set-initial-password failed: ${result.stderr.trim()}`);
    }
  }

  private findBrewPrefix(): Promise<string | null> {
    this.brewPrefix ??= this.runner
      .run('brew', ['--prefix', NEO4J_FORMULA])
      .then((result) => (result.exitCode === 0 ? result.stdout.trim() : null));
    return this.brewPrefix;
  }

  private async requireBrewPrefix(): Promise<string> {
    const prefix = await this.findBrewPrefix();
    if (prefix === null || !(await this.fileSystem.exists(join(prefix, 'bin', 'neo4j')))) {
      throw new Error('Neo4j is not installed through Homebrew; run: brew install neo4j');
    }
    return prefix;
  }
}

export const createNativeNeo4jProvider = (): NativeNeo4jProvider =>
  new NativeNeo4jProvider(new ProcessCommandRunner(), new NodeNativeFileSystem(), resolveNativeSettings());
