/**
 * Chunk Worker
 * Receives file chunks from coordinator, parses them, returns nodes/edges.
 * Each worker creates its own parser with lazyLoad=true for memory efficiency.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parentPort, workerData } from 'worker_threads';

// Load environment variables in worker thread
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// `quiet: true` is MANDATORY — see parse-coordinator.ts for the reason.
dotenv.config({ path: join(__dirname, '..', '..', '..', '.env'), quiet: true });

import { ParserFactory } from '../../core/parsers/parser-factory.js';
import { StreamingParser } from '../../core/parsers/typescript-parser.js';

import {
  ChunkWorkerConfig,
  CoordinatorToWorkerMessage,
  ChunkWorkerReady,
  ChunkWorkerResult,
  ChunkWorkerError,
  SerializedDeferredEdge,
} from './chunk-worker.types.js';

const config = workerData as ChunkWorkerConfig;

let parser: StreamingParser | null = null;

const sendReady = (): void => {
  const msg: ChunkWorkerReady = { type: 'ready' };
  parentPort?.postMessage(msg);
};

const sendResult = (result: Omit<ChunkWorkerResult, 'type'>): void => {
  const msg: ChunkWorkerResult = { type: 'result', ...result };
  parentPort?.postMessage(msg);
};

const sendError = (chunkIndex: number, error: Error): void => {
  const msg: ChunkWorkerError = {
    type: 'error',
    chunkIndex,
    error: error.message,
    stack: error.stack,
  };
  parentPort?.postMessage(msg);
};

/**
 * Initialize parser lazily on first chunk.
 * Uses lazyLoad=true so parser only loads files we give it.
 * projectType is already resolved by coordinator (no auto-detection here).
 */
const initParser = (): StreamingParser => {
  if (parser) return parser;

  parser = ParserFactory.createParser({
    workspacePath: config.projectPath,
    tsConfigPath: config.tsconfigPath,
    projectType: config.projectType,
    projectId: config.projectId,
    lazyLoad: true, // Critical: only load files we're given
  });

  // Defer edge enhancements - coordinator will handle after all chunks complete
  parser.setDeferEdgeEnhancements(true);

  return parser;
};

const processChunk = async (files: string[], chunkIndex: number): Promise<void> => {
  try {
    const p = initParser();

    // Clear any accumulated data from previous chunks
    p.clearParsedData();

    // Parse chunk - skip deferred edge resolution (coordinator handles that)
    const { nodes, edges } = await p.parseChunk(files, true);

    // Get serialized shared context for merging in coordinator
    const sharedContext = p.getSerializedSharedContext();

    // Get deferred edges for cross-chunk resolution
    const deferredEdges = p.getDeferredEdges() as SerializedDeferredEdge[];

    sendResult({
      chunkIndex,
      nodes,
      edges,
      filesProcessed: files.length,
      sharedContext,
      deferredEdges,
    });
  } catch (error) {
    sendError(chunkIndex, error instanceof Error ? error : new Error(String(error)));
  }
};

parentPort?.on('message', async (msg: CoordinatorToWorkerMessage) => {
  switch (msg.type) {
    case 'chunk':
      await processChunk(msg.files, msg.chunkIndex);
      sendReady();
      break;

    case 'terminate':
      parser?.clearParsedData();
      process.exit(0);
      break;
  }
});

sendReady();
