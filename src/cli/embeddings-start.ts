/**
 * `code-graph-context embeddings start`: make sure a local embedding server is
 * running, detached from this process, so any client can use it.
 *
 * Exit codes: 0 when the server is healthy, 1 when it is not or exited early.
 */

import { ChildProcess } from 'child_process';
import { closeSync, openSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { getLocalEmbeddingModel } from '../core/embeddings/embedding-config.js';
import {
  EmbeddingServerLaunchOptions,
  ServerProbe,
  launchEmbeddingServer,
  probeEmbeddingServer,
} from '../core/embeddings/embedding-server-launch.js';
import { DEFAULT_SIDECAR_CONFIG, SidecarConfig } from '../core/embeddings/embedding-sidecar.js';

export const EMBEDDING_SERVER_LOG_PATH = join(tmpdir(), 'code-graph-context-embedding-sidecar.log');

const POLL_INTERVAL_MS = 1000;

export interface EmbeddingsStartDependencies {
  config: SidecarConfig;
  logPath: string;
  probe: (baseUrl: string) => Promise<ServerProbe>;
  launch: (options: EmbeddingServerLaunchOptions) => ChildProcess;
  sleep: (ms: number) => Promise<void>;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

const defaultDependencies = (): EmbeddingsStartDependencies => ({
  config: { ...DEFAULT_SIDECAR_CONFIG, model: getLocalEmbeddingModel() },
  logPath: EMBEDDING_SERVER_LOG_PATH,
  probe: probeEmbeddingServer,
  launch: launchEmbeddingServer,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  writeStdout: (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line) => process.stderr.write(`${line}\n`),
});

/** Spawn the server detached with output appended to the log file; returns a reader for why it ended. */
const spawnDetachedServer = (deps: EmbeddingsStartDependencies): (() => string | null) => {
  const { config } = deps;
  const logFd = openSync(deps.logPath, 'a');
  let failure: string | null = null;
  let child: ChildProcess;
  try {
    child = deps.launch({
      host: config.host,
      port: config.port,
      model: config.model,
      idleTimeoutS: config.idleTimeoutS,
      watchParent: false,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.on('error', (err) => {
    failure = `could not start the server process: ${err.message}`;
  });
  child.on('exit', (code, signal) => {
    failure = `server process exited during startup (code=${code}, signal=${signal})`;
  });
  child.unref();
  return () => failure;
};

export const runEmbeddingsStart = async (
  deps: EmbeddingsStartDependencies = defaultDependencies(),
): Promise<number> => {
  const { config } = deps;
  const baseUrl = `http://${config.host}:${config.port}`;
  const ready = (model: string | undefined): number => {
    deps.writeStdout(`Embedding server ready: model ${model ?? config.model}, port ${config.port}`);
    return 0;
  };
  const fail = (reason: string): number => {
    deps.writeStderr(`Embedding server not ready: ${reason}. See ${deps.logPath}`);
    return 1;
  };

  const initial = await deps.probe(baseUrl);
  if (initial.state === 'healthy') return ready(initial.model);

  // A server that answers while loading its model owns the port; wait for it instead of spawning a second one.
  const readSpawnFailure = initial.state === 'absent' ? spawnDetachedServer(deps) : () => null;

  const attempts = Math.ceil(config.startupTimeoutMs / POLL_INTERVAL_MS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await deps.sleep(POLL_INTERVAL_MS);
    const spawnFailure = readSpawnFailure();
    if (spawnFailure) return fail(spawnFailure);
    const probe = await deps.probe(baseUrl);
    if (probe.state === 'healthy') return ready(probe.model);
  }
  return fail(`not healthy within ${config.startupTimeoutMs}ms`);
};
