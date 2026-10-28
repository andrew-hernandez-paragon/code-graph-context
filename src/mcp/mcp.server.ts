#!/usr/bin/env node
/**
 *
 * MCP Server - Main Entry Point
 * Clean, modular architecture for the Code Graph Context MCP Server
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file - must run before other imports use env vars
// eslint-disable-next-line import/order
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up two levels from dist/mcp/mcp.server.js to the root
const rootDir = join(__dirname, '..', '..');
dotenv.config({ path: join(rootDir, '.env'), quiet: true });

// eslint-disable-next-line import/order
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { stopEmbeddingSidecar } from '../core/embeddings/embedding-sidecar.js';

import { MESSAGES, TOOL_NAMES } from './constants.js';
import { createMcpServer } from './create-server.js';
import { performIncrementalParse } from './handlers/incremental-parse.handler.js';
import { initializeServices } from './service-init.js';
import { watchManager } from './services/watch-manager.js';
import { debugLog } from './utils.js';

// Track server state for debugging
let serverStartTime: Date;
const toolCallCount = 0;
const lastToolCall: string | null = null;

/**
 * Log memory usage and server stats
 */
const logServerStats = async (context: string): Promise<void> => {
  const mem = process.memoryUsage();
  await debugLog(`Server stats [${context}]`, {
    uptime: serverStartTime ? `${Math.round((Date.now() - serverStartTime.getTime()) / 1000)}s` : 'not started',
    toolCallCount,
    lastToolCall,
    memory: {
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    },
    pid: process.pid,
  });
};

/**
 * Main server initialization and startup
 */
const startServer = async (): Promise<void> => {
  serverStartTime = new Date();
  console.error(JSON.stringify({ level: 'info', message: MESSAGES.server.starting }));
  await debugLog('Server starting', { pid: process.pid, startTime: serverStartTime.toISOString() });

  const server = createMcpServer();
  await debugLog('Tools registered', { toolCount: Object.keys(TOOL_NAMES).length });

  // Configure watch manager with incremental parse handler and MCP server
  watchManager.setIncrementalParseHandler(performIncrementalParse);
  watchManager.setMcpServer(server.server);

  // Initialize external services (non-blocking but with proper error handling)
  initializeServices().catch(async (error) => {
    // Await the debugLog to ensure it completes before potential exit
    await debugLog('Service initialization error', error);
    // Log to stderr so it's visible even if debug file fails
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Service initialization failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  // Create and connect transport
  console.error(JSON.stringify({ level: 'info', message: MESSAGES.server.creatingTransport }));
  await debugLog('Creating stdio transport', {});
  const transport = new StdioServerTransport();

  // Add transport event logging
  process.stdin.on('close', async () => {
    await debugLog('STDIN closed - client disconnected', {});
    await logServerStats('stdin-close');
  });

  process.stdin.on('end', async () => {
    await debugLog('STDIN ended', {});
    await logServerStats('stdin-end');
  });

  process.stdin.on('error', async (err) => {
    await debugLog('STDIN error', { error: err.message, stack: err.stack });
  });

  process.stdout.on('close', async () => {
    await debugLog('STDOUT closed', {});
  });

  process.stdout.on('error', async (err) => {
    await debugLog('STDOUT error', { error: err.message, stack: err.stack });
  });

  console.error(JSON.stringify({ level: 'info', message: MESSAGES.server.connectingTransport }));
  await debugLog('Connecting transport', {});
  await server.connect(transport);

  console.error(JSON.stringify({ level: 'info', message: MESSAGES.server.connected }));
  await debugLog('Server connected and ready', { pid: process.pid });
  await logServerStats('server-ready');
};

/**
 * Graceful shutdown handler
 */
const shutdown = async (signal: string): Promise<void> => {
  console.error(JSON.stringify({ level: 'info', message: `Received ${signal}, shutting down...` }));
  await logServerStats(`shutdown-${signal}`);
  try {
    await watchManager.stopAllWatchers();
    await stopEmbeddingSidecar();
    await debugLog('Shutdown complete', { signal });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Error during shutdown', error: String(error) }));
    await debugLog('Error during shutdown', { signal, error: String(error) });
  }
  process.exit(0);
};

// Register exception handlers to catch native crashes
process.on('uncaughtException', async (error) => {
  console.error(
    JSON.stringify({ level: 'error', message: 'Uncaught exception', error: String(error), stack: error.stack }),
  );
  await debugLog('Uncaught exception', { error: String(error), stack: error.stack });
  await logServerStats('uncaught-exception');
  await stopEmbeddingSidecar();
});

process.on('unhandledRejection', async (reason) => {
  console.error(JSON.stringify({ level: 'error', message: 'Unhandled rejection', reason: String(reason) }));
  await debugLog('Unhandled rejection', { reason: String(reason) });
  await logServerStats('unhandled-rejection');
  await stopEmbeddingSidecar();
});

// Log other process events that might indicate issues
process.on('warning', async (warning) => {
  await debugLog('Process warning', { name: warning.name, message: warning.message, stack: warning.stack });
});

process.on('beforeExit', async (code) => {
  await debugLog('Process beforeExit', { code });
  await logServerStats('before-exit');
  await stopEmbeddingSidecar();
});

process.on('exit', (code) => {
  // Note: Can't use async here, exit is synchronous
  console.error(JSON.stringify({ level: 'info', message: `Process exiting with code ${code}` }));
});

// Register shutdown handlers
// NOTE: Only handle SIGTERM for graceful shutdown. SIGINT is ignored because
// Claude Code may propagate SIGINT to child processes when spawning agents,
// which would incorrectly kill the MCP server. The MCP server lifecycle is
// managed by Claude Code via stdio transport closure.
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Log SIGINT but don't exit - Claude Code manages our lifecycle
process.on('SIGINT', async () => {
  await debugLog('SIGINT received but ignored - lifecycle managed by Claude Code', {});
  await logServerStats('sigint-ignored');
});

// Also ignore SIGHUP which can be sent during terminal operations
process.on('SIGHUP', async () => {
  await debugLog('SIGHUP received but ignored', {});
  await logServerStats('sighup-ignored');
});

// Start the server
console.error(JSON.stringify({ level: 'info', message: MESSAGES.server.startingServer }));
await startServer();
