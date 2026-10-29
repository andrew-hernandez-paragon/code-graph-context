/**
 * Embedding Sidecar Manager
 * Manages a Python FastAPI process that serves local embedding requests.
 * The sidecar loads the model once and keeps it warm between requests.
 */

import { spawn, ChildProcess } from 'child_process';

import { DEFAULT_LOCAL_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, getLocalEmbeddingModel } from './embedding-config.js';
import {
  launchEmbeddingServer,
  probeEmbeddingServer,
  readIdleTimeoutS,
  resolvePython,
} from './embedding-server-launch.js';

export interface SidecarConfig {
  port: number;
  host: string;
  model: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutS: number;
}

/** A rerank waits on the recall that asked for it, so it gets far less time than a bulk embed. */
const RERANK_TIMEOUT_MS = parseInt(process.env.RERANK_TIMEOUT_MS ?? '', 10) || 15_000;

export const DEFAULT_SIDECAR_CONFIG: SidecarConfig = {
  port: parseInt(process.env.EMBEDDING_SIDECAR_PORT ?? '', 10) || 8787,
  host: '127.0.0.1',
  model: DEFAULT_LOCAL_EMBEDDING_MODEL,
  startupTimeoutMs: parseInt(process.env.EMBEDDING_STARTUP_TIMEOUT_MS ?? '', 10) || 120_000,
  requestTimeoutMs: parseInt(process.env.EMBEDDING_REQUEST_TIMEOUT_MS ?? '', 10) || 120_000,
  idleTimeoutS: readIdleTimeoutS(),
};

export class EmbeddingModelMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingModelMismatchError';
  }
}

export class EmbeddingSidecar {
  private process: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private config: SidecarConfig;
  private _dimensions: number | null = null;
  private stopping = false;
  private _exitHandler: (() => void) | null = null;

  // Concurrency semaphore — model.encode() is GPU-bound and processes
  // requests serially inside uvicorn. If 15 workers send requests at once,
  // the first takes ~3s, the last waits ~45s and times out. By queuing
  // excess requests here (no timeout pressure) we let only N through at a
  // time, keeping each request well within the 60s timeout.
  private readonly maxConcurrent = parseInt(process.env.EMBEDDING_MAX_CONCURRENT ?? '', 10) || 2;
  private inflight = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(config: Partial<SidecarConfig> = {}) {
    this.config = { ...DEFAULT_SIDECAR_CONFIG, model: getLocalEmbeddingModel(), ...config };
  }

  /**
   * Wait for a concurrency slot. If under the limit, returns immediately.
   * Otherwise parks the caller in a FIFO queue until a slot opens.
   */
  private acquireSlot(): Promise<void> | void {
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return; // fast path — no allocation, no Promise
    }
    return new Promise<void>((resolve) =>
      this.waitQueue.push(() => {
        this.inflight++;
        resolve();
      }),
    );
  }

  /**
   * Release a slot, unblocking the next queued caller if any.
   */
  private releaseSlot(): void {
    this.inflight--;
    const next = this.waitQueue.shift();
    if (next) next(); // wake one waiter — it will increment inflight
  }

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.stopping;
  }

  /**
   * Start the sidecar process. No-ops if already running.
   * Resolves when the server is healthy and ready to serve requests.
   */
  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.stopping = false;
    this.readyPromise = this.doStart();

    try {
      await this.readyPromise;
    } catch (err) {
      // Clean up on failed start
      this.cleanup();
      throw err;
    }
  }

  private async doStart(): Promise<void> {
    // Something may already own the port (a previous run, or another client's server)
    const probe = await probeEmbeddingServer(this.baseUrl);
    if (probe.state === 'healthy') {
      this.checkModel(probe.model, probe.dimensions);
      console.error(`[embedding-sidecar] Server already running on ${this.baseUrl}`);
      return;
    }
    if (probe.state === 'loading') {
      console.error(`[embedding-sidecar] Server on ${this.baseUrl} is still loading, waiting for it`);
      await this.waitForHealthy();
      return;
    }

    await this.verifyPython();

    console.error(
      `[embedding-sidecar] Starting on ${this.baseUrl} (python: ${resolvePython()}, model: ${this.config.model})`,
    );

    this.process = launchEmbeddingServer({
      host: this.config.host,
      port: this.config.port,
      model: this.config.model,
      idleTimeoutS: this.config.idleTimeoutS,
      // stdin='pipe' so the child detects parent death when the pipe breaks. stdout is ignored: uvicorn writes an
      // access line per request there, and a pipe nobody reads fills and blocks the server after ~1000 requests.
      watchParent: true,
      detached: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    // Store pid for synchronous cleanup on exit
    const child = this.process;
    const childPid = child.pid;

    // Forward stderr only when CGC_DEBUG is set — the sidecar can be chatty
    // during embedding (per-batch progress), and flooding stderr through
    // Claude Code's MCP pipe can back-pressure the worker.
    const forwardSidecarStderr = process.env.CGC_DEBUG === '1' || process.env.CGC_DEBUG === 'true';
    this.process.stderr?.on('data', (data: Buffer) => {
      if (!forwardSidecarStderr) return;
      const line = data.toString().trim();
      if (line) console.error(`[embedding-sidecar] ${line}`);
    });

    this.process.on('error', (err) => {
      console.error(`[embedding-sidecar] Process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (!this.stopping) {
        console.error(
          `[embedding-sidecar] Process exited unexpectedly (pid=${childPid}, code=${code}, signal=${signal}, ` +
            `inflight=${this.inflight}, queued=${this.waitQueue.length})`,
        );
      } else {
        console.error(`[embedding-sidecar] Process stopped (pid=${childPid})`);
      }
      // A discarded child can exit after its replacement started; leave the replacement's state alone.
      if (this.process === child) this.cleanup();
    });

    // Synchronous kill on parent exit — this is the only guaranteed cleanup
    // when the Node process dies unexpectedly (SIGKILL, crash, etc.)
    if (childPid) {
      const exitHandler = (): void => {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Process already dead — ignore
        }
      };
      process.on('exit', exitHandler);
      // Store handler so we can remove it when the sidecar stops normally
      this._exitHandler = exitHandler;
    }

    // Poll until healthy
    await this.waitForHealthy();
  }

  private async verifyPython(): Promise<void> {
    const python = resolvePython();
    return new Promise<void>((resolve, reject) => {
      const check = spawn(python, ['--version'], { stdio: 'pipe' });
      let output = '';
      check.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      check.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      check.on('error', () => {
        reject(
          new Error(
            `${python} not found. Local embeddings require Python 3.10+.\n\n` +
              'Install Python and the sidecar dependencies:\n' +
              '  pip install -r sidecar/requirements.txt\n\n' +
              'Or set OPENAI_EMBEDDINGS_ENABLED=true to use OpenAI instead.',
          ),
        );
      });
      check.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${python} check failed: ${output}`));
        } else {
          resolve();
        }
      });
    });
  }

  private async waitForHealthy(): Promise<void> {
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < this.config.startupTimeoutMs) {
      if (this.stopping) throw new Error('Sidecar stopped during startup');
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`Sidecar process exited during startup with code ${this.process.exitCode}`);
      }

      if (await this.checkHealth()) {
        console.error(`[embedding-sidecar] Ready (${Date.now() - start}ms)`);
        return;
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `Embedding sidecar failed to start within ${this.config.startupTimeoutMs}ms.\n` +
        'This usually means the model is still downloading or dependencies are missing.\n\n' +
        'Try running manually:\n' +
        '  cd sidecar && python3 -m uvicorn embedding_server:app --host 127.0.0.1 --port 8787',
    );
  }

  async checkHealth(timeoutMs = 2000): Promise<boolean> {
    const probe = await probeEmbeddingServer(this.baseUrl, timeoutMs);
    if (probe.state !== 'healthy') return false;
    // A healthy server with a different model must never be reused or replaced.
    this.checkModel(probe.model, probe.dimensions);
    return true;
  }

  private checkModel(model: string | undefined, dimensions: number | undefined): void {
    if (model !== this.config.model) {
      throw new EmbeddingModelMismatchError(
        `Embedding sidecar at ${this.baseUrl} reports model ${model ?? 'unknown'}; expected ${this.config.model}. ` +
          'Use the same EMBEDDING_MODEL for every client sharing this sidecar.',
      );
    }
    const expectedDimensions = EMBEDDING_DIMENSIONS[this.config.model] ?? this._dimensions;
    if (
      !Number.isInteger(dimensions) ||
      dimensions! <= 0 ||
      (expectedDimensions !== null && dimensions !== expectedDimensions)
    ) {
      throw new EmbeddingModelMismatchError(
        `Embedding sidecar returned ${dimensions ?? 'unknown'} dimensions for ${model}; ` +
          `expected ${expectedDimensions ?? 'a positive integer'}.`,
      );
    }
    this._dimensions = dimensions!;
  }

  /**
   * Embed an array of texts. Lazily starts the sidecar if not running.
   * Concurrency-limited: at most `maxConcurrent` requests hit the sidecar
   * at once. Excess callers wait in a FIFO queue (no timeout pressure).
   */
  async embed(texts: string[], gpuBatchSize?: number): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.start();
    const startedServer = this.readyPromise;
    try {
      return await this.requestEmbeddings(texts, gpuBatchSize);
    } catch (err) {
      // fetch rejects with TypeError when the connection fails: the server is gone.
      // An HTTP error response is a real answer and is not retried.
      if (!(err instanceof TypeError)) throw err;
      console.error('[embedding-sidecar] Server unreachable, starting it again');
      // Concurrent callers fail together; only the first discards, the rest join its restart.
      if (this.readyPromise === startedServer) this.discardStartedServer();
      await this.start();
      return await this.requestEmbeddings(texts, gpuBatchSize);
    }
  }

  private async requestEmbeddings(texts: string[], gpuBatchSize?: number): Promise<number[][]> {
    // Wait for a concurrency slot — the timeout only starts AFTER we
    // acquire the slot, so queued requests don't eat into their timeout.
    const queuedAt = Date.now();
    await this.acquireSlot();
    const queueMs = Date.now() - queuedAt;
    if (queueMs > 100) {
      console.error(
        `[embedding-sidecar] Waited ${queueMs}ms for concurrency slot (inflight=${this.inflight}, queued=${this.waitQueue.length})`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const startTime = Date.now();

    try {
      const body: { texts: string[]; batch_size?: number } = { texts };
      if (gpuBatchSize) body.batch_size = gpuBatchSize;

      const res = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text();
        const isOOM = detail.toLowerCase().includes('out of memory');

        if (res.status === 500 && isOOM) {
          console.error('[embedding-sidecar] OOM detected, restarting sidecar to reclaim GPU memory');
          await this.stop();
        }

        console.error(
          `[embedding-sidecar] Embed failed after ${Date.now() - startTime}ms: status=${res.status}, texts=${texts.length}, oom=${isOOM}, detail=${detail}`,
        );
        throw new Error(`Sidecar embed failed (${res.status}): ${detail}`);
      }

      const data = (await res.json()) as { embeddings: number[][]; dimensions: number; model?: string };
      this.checkModel(data.model, data.dimensions);
      if (
        !Array.isArray(data.embeddings) ||
        data.embeddings.length !== texts.length ||
        data.embeddings.some((vector) => !Array.isArray(vector) || vector.length !== data.dimensions)
      ) {
        throw new EmbeddingModelMismatchError('Embedding sidecar returned an inconsistent vector count or dimension.');
      }
      console.error(
        `[embedding-sidecar] Embedded ${texts.length} texts in ${Date.now() - startTime}ms (dims=${data.dimensions})`,
      );
      return data.embeddings;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error(
          `[embedding-sidecar] Request timed out after ${Date.now() - startTime}ms (limit=${this.config.requestTimeoutMs}ms, texts=${texts.length}), restarting sidecar`,
        );
        await this.stop();
        throw new Error(`Embedding request timed out after ${this.config.requestTimeoutMs}ms`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[embedding-sidecar] Embed error after ${Date.now() - startTime}ms: ${msg} (url=${this.baseUrl}, running=${this.isRunning}, texts=${texts.length})`,
      );
      throw err;
    } finally {
      clearTimeout(timeout);
      this.releaseSlot(); // always release, even on error
    }
  }

  /**
   * Score each text against the query with the sidecar's cross-encoder, from 0 to 1.
   * Returns null when no score is available: a sidecar from before /rerank, reranking
   * disabled, or a failed request. Callers keep their own order then.
   */
  async rerank(query: string, texts: string[]): Promise<number[] | null> {
    if (texts.length === 0) return [];
    try {
      await this.start();
    } catch (err) {
      console.error(`[embedding-sidecar] Rerank skipped, sidecar unavailable: ${String(err)}`);
      return null;
    }
    await this.acquireSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[embedding-sidecar] Rerank unavailable: status=${res.status}, ${await res.text()}`);
        return null;
      }
      const data = (await res.json()) as { scores?: unknown };
      const scores = data.scores;
      if (!Array.isArray(scores) || scores.length !== texts.length || scores.some((s) => typeof s !== 'number')) {
        console.error('[embedding-sidecar] Rerank returned an inconsistent score list');
        return null;
      }
      return scores as number[];
    } catch (err) {
      console.error(`[embedding-sidecar] Rerank failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timeout);
      this.releaseSlot();
    }
  }

  /**
   * Embed a single text. Convenience wrapper.
   */
  async embedText(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding;
  }

  /**
   * Stop the sidecar process.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.process) {
      console.error('[embedding-sidecar] Stopping...');
      this.process.kill('SIGTERM');

      // Give it 5s to shut down gracefully, then force kill
      await new Promise<void>((resolve) => {
        const forceKill = setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(forceKill);
          resolve();
        });
      });
    }

    this.cleanup();
  }

  /** Forget a server that stopped answering so the next start() launches or rejoins one. */
  private discardStartedServer(): void {
    this.process?.kill('SIGTERM');
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
    this.process = null;
    this.readyPromise = null;
  }

  private cleanup(): void {
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
    // Drain the wait queue — reject all queued callers so they don't hang forever
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift();
      if (waiter) waiter(); // unblock; they'll fail on the dead connection and can retry
    }
    this.inflight = 0;
    this.process = null;
    this.readyPromise = null;
  }
}

/**
 * Singleton sidecar instance — shared across all tool calls.
 * The sidecar starts lazily on first embed request and stays warm.
 */
let sidecarInstance: EmbeddingSidecar | null = null;

export const getEmbeddingSidecar = (): EmbeddingSidecar => {
  sidecarInstance ??= new EmbeddingSidecar();
  return sidecarInstance;
};

export const stopEmbeddingSidecar = async (): Promise<void> => {
  if (sidecarInstance) {
    await sidecarInstance.stop();
    sidecarInstance = null;
  }
};
