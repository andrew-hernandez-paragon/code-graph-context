/**
 * Types for chunk worker communication
 */

import { Neo4jNode, Neo4jEdge } from '../../core/config/schema.js';
import { ProjectType } from '../../core/parsers/parser-factory.js';
import { CallContext } from '../../core/parsers/typescript-parser.js';

/**
 * Data passed to chunk worker via workerData.
 * Coordinator resolves projectType before spawning workers (no 'auto').
 */
export interface ChunkWorkerConfig {
  projectPath: string;
  tsconfigPath: string;
  projectId: string;
  /** Resolved project type - coordinator handles detection, workers don't */
  projectType: ProjectType;
}

/**
 * Message sent from coordinator to chunk worker
 */
export interface ChunkWorkItem {
  type: 'chunk';
  chunkIndex: number;
  totalChunks: number;
  files: string[];
}

/**
 * Message sent from coordinator to terminate worker
 */
export interface ChunkWorkerTerminate {
  type: 'terminate';
}

export type CoordinatorToWorkerMessage = ChunkWorkItem | ChunkWorkerTerminate;

/**
 * Message sent from chunk worker when ready for work
 */
export interface ChunkWorkerReady {
  type: 'ready';
  workerId?: number;
}

/**
 * Serialized shared context from chunk worker.
 * Maps are converted to arrays of [key, value] for structured clone compatibility.
 */
export type SerializedSharedContext = Array<[string, unknown]>;

/**
 * Deferred edge that needs cross-chunk resolution.
 * These are EXTENDS, IMPLEMENTS, IMPORTS, and CALLS edges where target wasn't found in same chunk.
 */
export interface SerializedDeferredEdge {
  edgeType: string;
  sourceNodeId: string;
  targetName: string;
  targetType: string;
  targetFilePath?: string;
  callContext?: CallContext;
}

/**
 * Message sent from chunk worker with parse results
 */
export interface ChunkWorkerResult {
  type: 'result';
  chunkIndex: number;
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
  filesProcessed: number;
  /** Serialized shared context for merging in coordinator */
  sharedContext?: SerializedSharedContext;
  /** Deferred edges needing cross-chunk resolution */
  deferredEdges?: SerializedDeferredEdge[];
}

/**
 * Message sent from chunk worker on error
 */
export interface ChunkWorkerError {
  type: 'error';
  chunkIndex: number;
  error: string;
  stack?: string;
}

export type WorkerToCoordinatorMessage = ChunkWorkerReady | ChunkWorkerResult | ChunkWorkerError;
