/**
 * Chunk Worker Pool
 * Manages a pool of chunk workers for parallel parsing.
 * Uses message passing (pull model): workers signal ready, coordinator sends chunks.
 * Streams results as they complete for pipelined importing.
 */

import { cpus } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

import { Neo4jNode, Neo4jEdge } from '../../core/config/schema.js';
import { ProjectType } from '../../core/parsers/parser-factory.js';
import { debugLog } from '../utils.js';

import {
  ChunkWorkerConfig,
  ChunkWorkItem,
  WorkerToCoordinatorMessage,
  SerializedSharedContext,
  SerializedDeferredEdge,
} from './chunk-worker.types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PoolConfig {
  projectPath: string;
  tsconfigPath: string;
  projectId: string;
  projectType: ProjectType;
  numWorkers?: number;
}

export interface ChunkResult {
  chunkIndex: number;
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
  filesProcessed: number;
  sharedContext?: SerializedSharedContext;
  deferredEdges?: SerializedDeferredEdge[];
}

export interface PoolStats {
  totalNodes: number;
  totalEdges: number;
  totalFiles: number;
  chunksCompleted: number;
  totalChunks: number;
  elapsedMs: number;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
}

/**
 * Callback fired when a chunk completes. Use this for pipelined importing.
 * The callback can be async - pool waits for all callbacks to complete before resolving.
 */
export type OnChunkComplete = (result: ChunkResult, stats: PoolStats) => Promise<void>;

export class ChunkWorkerPool {
  private workers: WorkerState[] = [];
  private chunkQueue: ChunkWorkItem[] = [];
  private totalChunks = 0;
  private completedChunks = 0;
  private totalNodes = 0;
  private totalEdges = 0;
  private totalFiles = 0;
  private startTime = 0;
  private resolve: ((stats: PoolStats) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private onChunkComplete: OnChunkComplete | null = null;
  private pendingCallbacks: Promise<void>[] = [];
  private isShuttingDown = false;

  constructor(private config: PoolConfig) {
    process.on('exit', () => {
      this.forceTerminateAll();
    });
  }

  /**
   * Process chunks in parallel using worker pool.
   * Calls onChunkComplete for EACH result as it arrives (for pipelined importing).
   * Returns final stats when all chunks AND all callbacks are complete.
   */
  async processChunks(chunks: string[][], onChunkComplete: OnChunkComplete): Promise<PoolStats> {
    this.startTime = Date.now();
    this.totalChunks = chunks.length;
    this.completedChunks = 0;
    this.totalNodes = 0;
    this.totalEdges = 0;
    this.totalFiles = 0;
    this.onChunkComplete = onChunkComplete;
    this.pendingCallbacks = [];

    this.chunkQueue = chunks.map((files, index) => ({
      type: 'chunk' as const,
      chunkIndex: index,
      totalChunks: chunks.length,
      files,
    }));

    const numWorkers = this.config.numWorkers ?? Math.floor(cpus().length * 0.75);
    const actualWorkers = Math.min(numWorkers, chunks.length);

    debugLog(`Spawning ${actualWorkers} chunk workers for ${chunks.length} chunks`);

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      for (let i = 0; i < actualWorkers; i++) {
        this.spawnWorker();
      }
    });
  }

  private spawnWorker(): void {
    const workerPath = join(__dirname, 'chunk.worker.js');

    const workerConfig: ChunkWorkerConfig = {
      projectPath: this.config.projectPath,
      tsconfigPath: this.config.tsconfigPath,
      projectId: this.config.projectId,
      projectType: this.config.projectType,
    };

    const worker = new Worker(workerPath, {
      workerData: workerConfig,
      resourceLimits: {
        maxOldGenerationSizeMb: parseInt(process.env.CHUNK_WORKER_MAX_OLD_SPACE_MB ?? '', 10) || 2048,
        maxYoungGenerationSizeMb: parseInt(process.env.CHUNK_WORKER_MAX_YOUNG_SPACE_MB ?? '', 10) || 512,
      },
    });

    const state: WorkerState = { worker, busy: false };
    this.workers.push(state);

    worker.on('message', (msg: WorkerToCoordinatorMessage) => {
      this.handleWorkerMessage(state, msg);
    });

    worker.on('error', (error) => {
      debugLog('Worker error', { error: error.message });
      this.reject?.(error);
      void this.shutdown();
    });

    worker.on('exit', (code) => {
      if (code !== 0 && this.completedChunks < this.totalChunks) {
        this.reject?.(new Error(`Worker exited with code ${code}`));
        void this.shutdown();
      }
    });
  }

  private handleWorkerMessage(state: WorkerState, msg: WorkerToCoordinatorMessage): void {
    switch (msg.type) {
      case 'ready':
        state.busy = false;
        this.dispatchNextChunk(state);
        break;

      case 'result':
        this.handleResult(msg);
        break;

      case 'error':
        debugLog(`Chunk ${msg.chunkIndex} failed`, { error: msg.error });
        this.reject?.(new Error(`Chunk ${msg.chunkIndex} failed: ${msg.error}`));
        void this.shutdown();
        break;
    }
  }

  private handleResult(msg: WorkerToCoordinatorMessage & { type: 'result' }): void {
    this.completedChunks++;
    this.totalNodes += msg.nodes.length;
    this.totalEdges += msg.edges.length;
    this.totalFiles += msg.filesProcessed;

    const result: ChunkResult = {
      chunkIndex: msg.chunkIndex,
      nodes: msg.nodes,
      edges: msg.edges,
      filesProcessed: msg.filesProcessed,
      sharedContext: msg.sharedContext,
      deferredEdges: msg.deferredEdges,
    };

    const stats = this.getStats();

    // Fire callback immediately - enables pipelined importing
    if (this.onChunkComplete) {
      const callbackPromise = this.onChunkComplete(result, stats).catch((err) => {
        debugLog(`Import callback failed for chunk ${msg.chunkIndex}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });
      this.pendingCallbacks.push(callbackPromise);
    }

    // Check if all parsing is done
    if (this.completedChunks === this.totalChunks) {
      this.completeWhenCallbacksDone();
    }
  }

  private async completeWhenCallbacksDone(): Promise<void> {
    try {
      await Promise.all(this.pendingCallbacks);
    } catch (error) {
      this.reject?.(error instanceof Error ? error : new Error(String(error)));
      await this.shutdown();
      return;
    }

    await this.shutdown();
    this.resolve?.(this.getStats());
  }

  private getStats(): PoolStats {
    return {
      totalNodes: this.totalNodes,
      totalEdges: this.totalEdges,
      totalFiles: this.totalFiles,
      chunksCompleted: this.completedChunks,
      totalChunks: this.totalChunks,
      elapsedMs: Date.now() - this.startTime,
    };
  }

  private dispatchNextChunk(state: WorkerState): void {
    if (this.chunkQueue.length === 0) {
      return;
    }

    const chunk = this.chunkQueue.shift()!;
    state.busy = true;
    state.worker.postMessage(chunk);
  }

  /**
   * Graceful shutdown - lets workers finish cleanup
   * Call this on normal completion
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    const exitPromises = this.workers.map(({ worker }) => {
      return new Promise<void>((resolve) => {
        worker.on('exit', () => resolve());
        worker.postMessage({ type: 'terminate' });
      });
    });

    await Promise.race([Promise.all(exitPromises), new Promise((resolve) => setTimeout(resolve, 15000))]);

    this.forceTerminateAll();
  }

  private forceTerminateAll(): void {
    for (const { worker } of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}
