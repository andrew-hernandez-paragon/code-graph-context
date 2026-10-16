import { beforeEach, describe, expect, it } from 'vitest';

import { CommandResult, CommandRunner } from '../command-runner.js';
import { resolveNativePaths } from '../neo4j-native-files.js';
import { NativeFileSystem, NativeNeo4jProvider, NativeNeo4jSettings } from '../neo4j-native.js';

const PREFIX = '/opt/homebrew/opt/neo4j';
const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
const failed: CommandResult = { exitCode: 1, stdout: '', stderr: 'boom' };

class FakeFileSystem implements NativeFileSystem {
  files = new Map<string, string>();
  directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }
  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT ${path}`);
    return content;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async makeDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }
  async copyFile(source: string, destination: string): Promise<void> {
    this.files.set(destination, await this.readFile(source));
  }
  async listDirectory(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
      .map((f) => f.slice(prefix.length));
  }
  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class ScriptedRunner implements CommandRunner {
  calls: { command: string; args: string[]; env?: Record<string, string> }[] = [];
  loaded = false;
  bootstrapResult = ok;

  async run(command: string, args: string[], options: { env?: Record<string, string> } = {}): Promise<CommandResult> {
    this.calls.push({ command, args, env: options.env });
    const line = [command, ...args].join(' ');
    if (line === 'brew --prefix neo4j') return { ...ok, stdout: `${PREFIX}\n` };
    if (line === 'brew --version') return ok;
    if (line === `${PREFIX}/bin/neo4j --version`) return { ...ok, stdout: '2026.02.2\n' };
    if (line.startsWith('launchctl print')) return this.loaded ? ok : failed;
    if (line.startsWith('launchctl bootstrap')) {
      this.loaded = this.loaded || this.bootstrapResult.exitCode === 0;
      return this.bootstrapResult;
    }
    if (line.startsWith('launchctl bootout')) {
      this.loaded = false;
      return ok;
    }
    return ok;
  }

  launchctlCalls(): string[] {
    return this.calls.filter((c) => c.command === 'launchctl' && c.args[0] !== 'print').map((c) => c.args.join(' '));
  }
}

const settings: NativeNeo4jSettings = {
  paths: resolveNativePaths('/h/neo4j'),
  launchdLabel: 'dev.cgc.test',
  launchAgentsDir: '/u/Library/LaunchAgents',
  uid: 501,
};

const configureOptions = {
  boltPort: 27687,
  httpPort: 27474,
  password: 'secretpw1',
  heapMax: '512M',
  pagecache: '256M',
};

let runner: ScriptedRunner;
let fileSystem: FakeFileSystem;
let provider: NativeNeo4jProvider;

beforeEach(() => {
  runner = new ScriptedRunner();
  fileSystem = new FakeFileSystem();
  fileSystem.files.set(`${PREFIX}/bin/neo4j`, '#!/bin/bash');
  fileSystem.files.set(
    `${PREFIX}/libexec/conf/neo4j.conf`,
    'server.bolt.enabled=true\nserver.directories.data=/brew/data\n',
  );
  fileSystem.files.set(`${PREFIX}/libexec/conf/neo4j-admin.conf`, 'admin=1\n');
  fileSystem.files.set(`${PREFIX}/libexec/labs/apoc-2026.02.2-core.jar`, 'jar-bytes');
  provider = new NativeNeo4jProvider(runner, fileSystem, settings);
});

describe('NativeNeo4jProvider.configure', () => {
  it('writes the generated conf, copies neo4j-admin.conf unchanged, and writes the plist', async () => {
    await provider.configure(configureOptions);

    const conf = fileSystem.files.get('/h/neo4j/conf/neo4j.conf');
    expect(conf).toContain('server.bolt.enabled=true\n');
    expect(conf).not.toContain('/brew/data');
    expect(conf).toContain('server.bolt.listen_address=127.0.0.1:27687\n');
    expect(fileSystem.files.get('/h/neo4j/conf/neo4j-admin.conf')).toBe('admin=1\n');
    expect(fileSystem.files.get('/u/Library/LaunchAgents/dev.cgc.test.plist')).toContain(
      '<string>dev.cgc.test</string>',
    );
  });

  it('gives identical files when run twice', async () => {
    await provider.configure(configureOptions);
    const first = new Map(fileSystem.files);
    await provider.configure(configureOptions);
    expect(fileSystem.files).toEqual(first);
  });

  it('replaces any apoc jar in its plugins dir with the core jar from labs', async () => {
    fileSystem.files.set('/h/neo4j/plugins/apoc-2025.01.0-core.jar', 'old');
    fileSystem.files.set('/h/neo4j/plugins/other-plugin.jar', 'keep');

    await provider.configure(configureOptions);

    expect([...fileSystem.files.keys()].filter((f) => f.startsWith('/h/neo4j/plugins/')).sort()).toEqual([
      '/h/neo4j/plugins/apoc-2026.02.2-core.jar',
      '/h/neo4j/plugins/other-plugin.jar',
    ]);
    expect(fileSystem.files.get('/h/neo4j/plugins/apoc-2026.02.2-core.jar')).toBe('jar-bytes');
  });

  it('sets the initial password through neo4j-admin with NEO4J_CONF before the system database exists', async () => {
    await provider.configure(configureOptions);

    const admin = runner.calls.find((c) => c.command === `${PREFIX}/bin/neo4j-admin`);
    expect(admin).toEqual({
      command: `${PREFIX}/bin/neo4j-admin`,
      args: ['dbms', 'set-initial-password', 'secretpw1'],
      env: { NEO4J_CONF: '/h/neo4j/conf' },
    });
  });

  it('skips the initial password once the system database exists', async () => {
    fileSystem.directories.add('/h/neo4j/data/databases/system');

    await provider.configure(configureOptions);

    expect(runner.calls.some((c) => c.command === `${PREFIX}/bin/neo4j-admin`)).toBe(false);
  });

  it('fails when neo4j-admin rejects the password', async () => {
    const brokenRunner = new ScriptedRunner();
    const original = brokenRunner.run.bind(brokenRunner);
    brokenRunner.run = async (command, args, options) =>
      command.endsWith('neo4j-admin') ? failed : original(command, args, options);
    provider = new NativeNeo4jProvider(brokenRunner, fileSystem, settings);

    await expect(provider.configure(configureOptions)).rejects.toThrow('set-initial-password failed: boom');
  });
});

describe('NativeNeo4jProvider service commands', () => {
  it('bootstraps the plist when the service is not loaded', async () => {
    await provider.startService();
    expect(runner.launchctlCalls()).toEqual([
      'enable gui/501/dev.cgc.test',
      'bootstrap gui/501 /u/Library/LaunchAgents/dev.cgc.test.plist',
    ]);
  });

  it('kickstarts without -k when the service is already loaded', async () => {
    runner.loaded = true;
    await provider.startService();
    expect(runner.launchctlCalls()).toEqual(['enable gui/501/dev.cgc.test', 'kickstart gui/501/dev.cgc.test']);
  });

  it('accepts a bootstrap failure when another caller loaded the service meanwhile', async () => {
    runner.bootstrapResult = failed;
    const original = runner.run.bind(runner);
    runner.run = async (command, args, options) => {
      const result = await original(command, args, options);
      if (args[0] === 'bootstrap') runner.loaded = true;
      return result;
    };
    await expect(provider.startService()).resolves.toBeUndefined();
  });

  it('throws when bootstrap fails and the service is still not loaded', async () => {
    runner.bootstrapResult = failed;
    await expect(provider.startService()).rejects.toThrow('launchctl bootstrap dev.cgc.test failed: boom');
  });

  it('boots the service out when loaded and does nothing when not', async () => {
    await provider.stopService();
    expect(runner.launchctlCalls()).toEqual([]);

    runner.loaded = true;
    await provider.stopService();
    expect(runner.launchctlCalls()).toEqual(['bootout gui/501/dev.cgc.test']);
  });

  it('disables the service so launchd does not start it at login', async () => {
    await provider.disableService();
    expect(runner.launchctlCalls()).toEqual(['disable gui/501/dev.cgc.test']);
  });
});

describe('NativeNeo4jProvider queries', () => {
  it('reports installed only when the Homebrew prefix holds a neo4j binary', async () => {
    expect(await provider.isInstalled()).toBe(true);
    fileSystem.files.delete(`${PREFIX}/bin/neo4j`);
    provider = new NativeNeo4jProvider(runner, fileSystem, settings);
    expect(await provider.isInstalled()).toBe(false);
  });

  it('reads the version from neo4j --version', async () => {
    expect(await provider.neo4jVersion()).toBe('2026.02.2');
  });

  it('reports data once databases/neo4j exists under its data dir', async () => {
    expect(await provider.hasData()).toBe(false);
    fileSystem.directories.add('/h/neo4j/data/databases/neo4j');
    expect(await provider.hasData()).toBe(true);
  });

  it('detects a started brew service for neo4j', async () => {
    const original = runner.run.bind(runner);
    runner.run = async (command, args, options) =>
      args[0] === 'services'
        ? { ...ok, stdout: 'Name   Status  User\nneo4j  started andrew ~/Library/x.plist\n' }
        : original(command, args, options);
    expect(await provider.isBrewServiceStarted()).toBe(true);
  });

  it('installs through brew install neo4j', async () => {
    await provider.install();
    expect(runner.calls.at(-1)).toEqual({ command: 'brew', args: ['install', 'neo4j'], env: undefined });
  });
});
