/**
 * Launching and probing the Python embedding server, shared by the in-process
 * EmbeddingSidecar and the `embeddings start` CLI command.
 */

import { spawn, ChildProcess, StdioOptions } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// sidecar/ lives at project root; go up from dist/core/embeddings/ or src/core/embeddings/
export const SIDECAR_DIR = join(__dirname, '..', '..', '..', 'sidecar');

export const DEFAULT_IDLE_TIMEOUT_S = 600;

export type ServerProbe =
  | { state: 'absent' }
  | { state: 'loading' }
  | { state: 'healthy'; model?: string; dimensions?: number };

export interface EmbeddingServerLaunchOptions {
  host: string;
  port: number;
  model: string;
  idleTimeoutS: number;
  /** True: the server exits when its stdin closes. False: it outlives the launcher. */
  watchParent: boolean;
  detached: boolean;
  stdio: StdioOptions;
}

/** EMBEDDING_IDLE_TIMEOUT_S wins; EMBEDDING_IDLE_TIMEOUT_MS is read for compatibility. 0 disables. */
export const readIdleTimeoutS = (): number => {
  const seconds = parseFloat(process.env.EMBEDDING_IDLE_TIMEOUT_S ?? '');
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const millis = parseFloat(process.env.EMBEDDING_IDLE_TIMEOUT_MS ?? '');
  if (Number.isFinite(millis) && millis >= 0) return Math.round(millis / 1000);
  return DEFAULT_IDLE_TIMEOUT_S;
};

/** Prefer PYTHON_EXECUTABLE, then the sidecar venv, then system python. */
export const resolvePython = (): string => {
  if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
  const isWindows = process.platform === 'win32';
  const venvPython = isWindows
    ? join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe')
    : join(SIDECAR_DIR, '.venv', 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  return isWindows ? 'python' : 'python3';
};

export const launchEmbeddingServer = (options: EmbeddingServerLaunchOptions): ChildProcess =>
  spawn(
    resolvePython(),
    ['-m', 'uvicorn', 'embedding_server:app', '--host', options.host, '--port', String(options.port)],
    {
      cwd: SIDECAR_DIR,
      detached: options.detached,
      stdio: options.stdio,
      env: {
        ...process.env,
        EMBEDDING_MODEL: options.model,
        EMBEDDING_IDLE_TIMEOUT_S: String(options.idleTimeoutS),
        EMBEDDING_WATCH_PARENT: options.watchParent ? '1' : '0',
      },
    },
  );

/**
 * Tell "nothing listening" from "listening but not healthy yet": any HTTP
 * response (the server answers 503 while the model loads) or a timeout means
 * a server owns the port; a failed connection means it is free.
 */
export const probeEmbeddingServer = async (baseUrl: string, timeoutMs = 2000): Promise<ServerProbe> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!res.ok) return { state: 'loading' };
    const data = (await res.json()) as { status?: string; dimensions?: number; model?: string };
    if (data.status !== 'ok') return { state: 'loading' };
    return { state: 'healthy', model: data.model, dimensions: data.dimensions };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { state: 'loading' };
    return { state: 'absent' };
  } finally {
    clearTimeout(timeout);
  }
};
