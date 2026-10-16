import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Neo4jProviderRecord } from '../../cli/neo4j-provider-record.js';
import {
  Neo4jStartupDependencies,
  Neo4jStartupService,
  STARTUP_RETRY_INTERVAL_MS,
  STARTUP_RETRY_MAX_ATTEMPTS,
  retryInBackground,
} from '../neo4j-startup.js';

const connection = { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'PASSWORD' };

const buildDependencies = (overrides: Partial<Neo4jStartupDependencies> = {}) => {
  const dependencies: Neo4jStartupDependencies = {
    getConnection: () => connection,
    readProviderRecord: () => null,
    probeBolt: vi.fn(async () => false),
    waitForBolt: vi.fn(async () => true),
    native: {
      paths: {
        home: '/h',
        conf: '/h/conf',
        data: '/h/data',
        logs: '/h/logs',
        plugins: '/h/p',
        run: '/h/r',
        import: '/h/i',
      },
      isConfigured: vi.fn(async () => true),
      startService: vi.fn(async () => undefined),
    },
    docker: {
      isInstalled: vi.fn(() => true),
      isRunning: vi.fn(() => true),
      ensureRunning: vi.fn(async () => ({ success: true, action: 'started' as const })),
    },
    ...overrides,
  };
  return dependencies;
};

const record = (provider: Neo4jProviderRecord['provider']): Neo4jProviderRecord => ({
  provider,
  boltPort: 7687,
  httpPort: 7474,
});

describe('Neo4jStartupService.ensureRunning', () => {
  it('returns without touching any provider when Bolt already answers', async () => {
    const dependencies = buildDependencies({
      probeBolt: vi.fn(async () => true),
      readProviderRecord: () => record('native'),
    });

    expect(await new Neo4jStartupService(dependencies).ensureRunning()).toBe('already-reachable');
    expect(dependencies.docker.isInstalled).not.toHaveBeenCalled();
    expect(dependencies.native.startService).not.toHaveBeenCalled();
  });

  it('starts the native service and waits for Bolt when the record says native', async () => {
    const dependencies = buildDependencies({ readProviderRecord: () => record('native') });

    expect(await new Neo4jStartupService(dependencies).ensureRunning()).toBe('native-started');
    expect(dependencies.native.startService).toHaveBeenCalledOnce();
    expect(dependencies.waitForBolt).toHaveBeenCalledWith(connection);
    expect(dependencies.docker.isInstalled).not.toHaveBeenCalled();
  });

  it('fails with the log directory when native Neo4j never answers', async () => {
    const dependencies = buildDependencies({
      readProviderRecord: () => record('native'),
      waitForBolt: vi.fn(async () => false),
    });

    await expect(new Neo4jStartupService(dependencies).ensureRunning()).rejects.toThrow(
      'Neo4j did not answer at bolt://localhost:7687 after starting the service. See /h/logs',
    );
  });

  it('fails without starting anything when native is recorded but not configured', async () => {
    const dependencies = buildDependencies({ readProviderRecord: () => record('native') });
    dependencies.native.isConfigured = vi.fn(async () => false);

    await expect(new Neo4jStartupService(dependencies).ensureRunning()).rejects.toThrow(
      'Native Neo4j is not configured. Run: code-graph-context init',
    );
    expect(dependencies.native.startService).not.toHaveBeenCalled();
  });

  it('uses the Docker flow when the record says docker', async () => {
    const dependencies = buildDependencies({ readProviderRecord: () => record('docker') });

    expect(await new Neo4jStartupService(dependencies).ensureRunning()).toBe('docker-started');
    expect(dependencies.native.startService).not.toHaveBeenCalled();
  });

  it('reports a created container', async () => {
    const dependencies = buildDependencies();
    dependencies.docker.ensureRunning = vi.fn(async () => ({ success: true, action: 'created' as const }));

    expect(await new Neo4jStartupService(dependencies).ensureRunning()).toBe('docker-created');
  });

  it('keeps the legacy Docker flow when there is no record and Docker is installed', async () => {
    const dependencies = buildDependencies();

    await new Neo4jStartupService(dependencies).ensureRunning();
    expect(dependencies.docker.ensureRunning).toHaveBeenCalledOnce();
  });

  it('tells the user to run init when there is no record and no Docker', async () => {
    const dependencies = buildDependencies();
    dependencies.docker.isInstalled = vi.fn(() => false);

    await expect(new Neo4jStartupService(dependencies).ensureRunning()).rejects.toThrow(
      'Neo4j is not reachable at bolt://localhost:7687; run code-graph-context init',
    );
  });

  it('fails when Docker is installed but not running', async () => {
    const dependencies = buildDependencies();
    dependencies.docker.isRunning = vi.fn(() => false);

    await expect(new Neo4jStartupService(dependencies).ensureRunning()).rejects.toThrow('Docker not running');
  });

  it('fails with the Docker error when the container cannot start', async () => {
    const dependencies = buildDependencies();
    dependencies.docker.ensureRunning = vi.fn(async () => ({
      success: false,
      action: 'failed' as const,
      error: 'port busy',
    }));

    await expect(new Neo4jStartupService(dependencies).ensureRunning()).rejects.toThrow(
      'Neo4j failed to start: port busy',
    );
  });
});

describe('retryInBackground', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops after the first attempt that succeeds and logs one line per attempt', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(undefined);
    const onAttempt = vi.fn();
    const onFailure = vi.fn();

    const outcome = retryInBackground({ attempt, onAttempt, onFailure });
    await vi.advanceTimersByTimeAsync(STARTUP_RETRY_INTERVAL_MS * 5);

    expect(await outcome).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls).toEqual([
      [1, STARTUP_RETRY_MAX_ATTEMPTS],
      [2, STARTUP_RETRY_MAX_ATTEMPTS],
    ]);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('waits one interval before each attempt', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined);

    const outcome = retryInBackground({ attempt, onAttempt: vi.fn(), onFailure: vi.fn() });
    await vi.advanceTimersByTimeAsync(STARTUP_RETRY_INTERVAL_MS - 1);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBe(true);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('gives up after 20 attempts at 30 second intervals', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('down'));

    const outcome = retryInBackground({ attempt, onAttempt: vi.fn(), onFailure: vi.fn() });
    await vi.advanceTimersByTimeAsync(STARTUP_RETRY_INTERVAL_MS * 25);

    expect(await outcome).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(20);
    expect(STARTUP_RETRY_INTERVAL_MS).toBe(30_000);
  });
});
