/**
 * Watch Manager Service
 * Manages file watchers for incremental graph updates across projects
 * Uses @parcel/watcher for high-performance file watching
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as watcher from '@parcel/watcher';
import type { AsyncSubscription } from '@parcel/watcher';

import { WATCH } from '../constants.js';
import { debugLog } from '../utils.js';

export type WatchEventType = 'add' | 'change' | 'unlink';

export interface WatchEvent {
  type: WatchEventType;
  filePath: string;
  timestamp: number;
}

export interface WatcherConfig {
  projectPath: string;
  projectId: string;
  tsconfigPath: string;
  debounceMs: number;
  excludePatterns: string[];
}

export interface WatcherState {
  projectId: string;
  projectPath: string;
  tsconfigPath: string;
  subscription: AsyncSubscription | null;
  config: WatcherConfig;
  pendingEvents: WatchEvent[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  isProcessing: boolean;
  isStopping: boolean;
  lastUpdateTime: Date | null;
  status: 'active' | 'paused' | 'error';
  errorMessage?: string;
}

export interface WatcherInfo {
  projectId: string;
  projectPath: string;
  status: 'active' | 'paused' | 'error';
  lastUpdateTime: string | null;
  pendingChanges: number;
  debounceMs: number;
  errorMessage?: string;
}

export interface WatchNotification {
  type:
    | 'file_change_detected'
    | 'incremental_parse_started'
    | 'incremental_parse_completed'
    | 'incremental_parse_failed';
  projectId: string;
  projectPath: string;
  data: {
    filesChanged?: string[];
    filesAdded?: string[];
    filesDeleted?: string[];
    nodesUpdated?: number;
    edgesUpdated?: number;
    elapsedMs?: number;
    error?: string;
  };
  timestamp: string;
}

export type IncrementalParseHandler = (
  projectPath: string,
  projectId: string,
  tsconfigPath: string,
) => Promise<{ nodesUpdated: number; edgesUpdated: number }>;

class WatchManager {
  private watchers: Map<string, WatcherState> = new Map();
  private mcpServer: Server | null = null;
  private incrementalParseHandler: IncrementalParseHandler | null = null;

  /**
   * Set the MCP server instance for sending notifications
   */
  setMcpServer(server: Server): void {
    this.mcpServer = server;
  }

  /**
   * Set the incremental parse handler function
   */
  setIncrementalParseHandler(handler: IncrementalParseHandler): void {
    this.incrementalParseHandler = handler;
  }

  /**
   * Send a notification via MCP logging (if supported)
   */
  private sendNotification(notification: WatchNotification): void {
    debugLog('sendNotification called', { type: notification.type, projectId: notification.projectId });

    if (!this.mcpServer) {
      debugLog('sendNotification: no MCP server, skipping', {});
      return;
    }

    debugLog('sendNotification: sending to MCP', { type: notification.type });

    // sendLoggingMessage returns a Promise - use .catch() to handle rejection
    this.mcpServer
      .sendLoggingMessage({
        level: notification.type.includes('failed') ? 'error' : 'info',
        logger: 'file-watcher',
        data: notification,
      })
      .then(() => {
        debugLog('sendNotification: MCP message sent successfully', { type: notification.type });
      })
      .catch((error) => {
        // MCP logging not supported - log but don't crash
        // This is expected if the client doesn't support logging capability
        debugLog('sendNotification: MCP message failed (expected if client lacks logging)', {
          type: notification.type,
          error: String(error),
        });
      });
  }

  /**
   * Start watching a project for file changes
   */
  async startWatching(
    config: Partial<WatcherConfig> & { projectPath: string; projectId: string; tsconfigPath: string },
  ): Promise<WatcherInfo> {
    // Check if already watching this project
    if (this.watchers.has(config.projectId)) {
      const existing = this.watchers.get(config.projectId)!;
      return this.getWatcherInfoFromState(existing);
    }

    // Enforce maximum watcher limit
    if (this.watchers.size >= WATCH.maxWatchers) {
      throw new Error(
        `Maximum watcher limit (${WATCH.maxWatchers}) reached. ` +
          `Stop an existing watcher before starting a new one.`,
      );
    }

    const fullConfig: WatcherConfig = {
      projectPath: config.projectPath,
      projectId: config.projectId,
      tsconfigPath: config.tsconfigPath,
      debounceMs: config.debounceMs ?? WATCH.defaultDebounceMs,
      excludePatterns: config.excludePatterns ?? [...WATCH.excludePatterns],
    };

    await debugLog('Creating @parcel/watcher subscription', {
      watchPath: fullConfig.projectPath,
      ignored: fullConfig.excludePatterns,
    });

    // Create state object first (subscription will be added after)
    const state: WatcherState = {
      projectId: fullConfig.projectId,
      projectPath: fullConfig.projectPath,
      tsconfigPath: fullConfig.tsconfigPath,
      subscription: null, // Will be set after successful subscription
      config: fullConfig,
      pendingEvents: [],
      debounceTimer: null,
      isProcessing: false,
      isStopping: false,
      lastUpdateTime: null,
      status: 'active',
    };

    try {
      // Subscribe to file changes using @parcel/watcher
      const subscription = await watcher.subscribe(
        fullConfig.projectPath,
        (err, events) => {
          if (err) {
            this.handleWatcherError(state, err);
            return;
          }

          for (const event of events) {
            try {
              // Filter for TypeScript files
              if (!event.path.endsWith('.ts') && !event.path.endsWith('.tsx')) {
                continue;
              }

              // Map parcel event types to our event types
              let eventType: WatchEventType;
              if (event.type === 'create') {
                eventType = 'add';
              } else if (event.type === 'delete') {
                eventType = 'unlink';
              } else {
                eventType = 'change';
              }

              this.handleFileEvent(state, eventType, event.path);
            } catch (error) {
              debugLog('Error processing file event', { error: String(error), path: event.path });
            }
          }
        },
        {
          ignore: fullConfig.excludePatterns,
        },
      );

      state.subscription = subscription;
      this.watchers.set(fullConfig.projectId, state);

      await debugLog('Watcher started', { projectId: fullConfig.projectId, projectPath: fullConfig.projectPath });

      // Check for changes that occurred while watcher was off (run in background)
      this.syncMissedChanges(state);

      return this.getWatcherInfoFromState(state);
    } catch (error) {
      await debugLog('Failed to start watcher', { error: String(error) });
      throw error;
    }
  }

  /**
   * Handle a file system event
   */
  private handleFileEvent(state: WatcherState, type: WatchEventType, filePath: string): void {
    debugLog('handleFileEvent START', {
      type,
      filePath,
      projectId: state.projectId,
      status: state.status,
      isStopping: state.isStopping,
    });

    // Ignore events if watcher is stopping or not active
    if (state.isStopping || state.status !== 'active') {
      debugLog('Ignoring event - watcher not active or stopping', {
        status: state.status,
        isStopping: state.isStopping,
      });
      return;
    }

    const event: WatchEvent = {
      type,
      filePath,
      timestamp: Date.now(),
    };

    // Prevent unbounded event accumulation - drop oldest events if buffer is full
    if (state.pendingEvents.length >= WATCH.maxPendingEvents) {
      debugLog('Event buffer full, dropping oldest events', { projectId: state.projectId });
      state.pendingEvents = state.pendingEvents.slice(-Math.floor(WATCH.maxPendingEvents / 2));
    }

    state.pendingEvents.push(event);
    debugLog('Event added to pending', { pendingCount: state.pendingEvents.length });

    // Clear existing debounce timer
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    // Send immediate notification about file change detected
    this.sendNotification({
      type: 'file_change_detected',
      projectId: state.projectId,
      projectPath: state.projectPath,
      data: {
        filesChanged: state.pendingEvents.filter((e) => e.type === 'change').map((e) => e.filePath),
        filesAdded: state.pendingEvents.filter((e) => e.type === 'add').map((e) => e.filePath),
        filesDeleted: state.pendingEvents.filter((e) => e.type === 'unlink').map((e) => e.filePath),
      },
      timestamp: new Date().toISOString(),
    });

    // Set new debounce timer
    debugLog('handleFileEvent: setting debounce timer', { debounceMs: state.config.debounceMs });
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.startProcessingEvents(state);
    }, state.config.debounceMs);
    debugLog('handleFileEvent END', { pendingCount: state.pendingEvents.length });
  }

  private startProcessingEvents(state: WatcherState): void {
    this.processEvents(state).catch((error) => {
      debugLog('processEvents error', { projectId: state.projectId, error: String(error) });
      console.error('[WatchManager] Error in processEvents:', error);
    });
  }

  /**
   * A debounce timer that fires during a parse finds the watcher busy and returns. The events it
   * was set for are processed here, unless a later timer is still due to pick them up.
   */
  private finishParse(state: WatcherState): void {
    state.isProcessing = false;
    if (state.debounceTimer === null) {
      this.startProcessingEvents(state);
    }
  }

  /**
   * Process accumulated file events after debounce period
   */
  private async processEvents(state: WatcherState): Promise<void> {
    await debugLog('processEvents START', {
      projectId: state.projectId,
      isProcessing: state.isProcessing,
      pendingCount: state.pendingEvents.length,
      isStopping: state.isStopping,
    });

    // Don't process if already processing, no events, or watcher is stopping
    if (state.isProcessing || state.pendingEvents.length === 0 || state.isStopping) {
      await debugLog('processEvents: early return', {
        reason: state.isProcessing ? 'already processing' : state.pendingEvents.length === 0 ? 'no events' : 'stopping',
      });
      return;
    }

    state.isProcessing = true;
    await debugLog('processEvents: set isProcessing=true', {});
    const events = [...state.pendingEvents];
    state.pendingEvents = [];

    const startTime = Date.now();

    this.sendNotification({
      type: 'incremental_parse_started',
      projectId: state.projectId,
      projectPath: state.projectPath,
      data: {
        filesChanged: events.filter((e) => e.type === 'change').map((e) => e.filePath),
        filesAdded: events.filter((e) => e.type === 'add').map((e) => e.filePath),
        filesDeleted: events.filter((e) => e.type === 'unlink').map((e) => e.filePath),
      },
      timestamp: new Date().toISOString(),
    });

    try {
      if (!this.incrementalParseHandler) {
        throw new Error('Incremental parse handler not configured');
      }

      await debugLog('processEvents: calling incrementalParseHandler', {
        projectPath: state.projectPath,
        projectId: state.projectId,
      });
      const result = await this.incrementalParseHandler(state.projectPath, state.projectId, state.tsconfigPath);
      await debugLog('processEvents: incrementalParseHandler returned', {
        nodesUpdated: result.nodesUpdated,
        edgesUpdated: result.edgesUpdated,
      });

      state.lastUpdateTime = new Date();
      const elapsedMs = Date.now() - startTime;

      this.sendNotification({
        type: 'incremental_parse_completed',
        projectId: state.projectId,
        projectPath: state.projectPath,
        data: {
          filesChanged: events.filter((e) => e.type === 'change').map((e) => e.filePath),
          filesAdded: events.filter((e) => e.type === 'add').map((e) => e.filePath),
          filesDeleted: events.filter((e) => e.type === 'unlink').map((e) => e.filePath),
          nodesUpdated: result.nodesUpdated,
          edgesUpdated: result.edgesUpdated,
          elapsedMs,
        },
        timestamp: new Date().toISOString(),
      });

      console.error(
        `[WatchManager] Incremental parse completed for ${state.projectId}: ` +
          `${result.nodesUpdated} nodes, ${result.edgesUpdated} edges in ${elapsedMs}ms`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await debugLog('processEvents: error caught', { error: errorMessage });

      this.sendNotification({
        type: 'incremental_parse_failed',
        projectId: state.projectId,
        projectPath: state.projectPath,
        data: {
          error: errorMessage,
          elapsedMs: Date.now() - startTime,
        },
        timestamp: new Date().toISOString(),
      });

      console.error(`[WatchManager] Incremental parse failed for ${state.projectId}:`, error);
    } finally {
      await debugLog('processEvents END', { projectId: state.projectId });
      this.finishParse(state);
    }
  }

  /**
   * Handle watcher error
   */
  private handleWatcherError(state: WatcherState, error: unknown): void {
    state.status = 'error';
    state.errorMessage = error instanceof Error ? error.message : String(error);
    debugLog('handleWatcherError START', { projectId: state.projectId, error: state.errorMessage });

    // Clean up the failed watcher to prevent it from staying in error state indefinitely
    this.stopWatching(state.projectId)
      .then(() => {
        debugLog('handleWatcherError: cleanup succeeded', { projectId: state.projectId });
      })
      .catch((cleanupError) => {
        debugLog('handleWatcherError: cleanup failed', {
          projectId: state.projectId,
          cleanupError: String(cleanupError),
        });
        console.error(`[WatchManager] Failed to cleanup errored watcher ${state.projectId}:`, cleanupError);
      });
  }

  /**
   * Sync any changes that occurred while the watcher was off
   * Runs in the background without blocking watcher startup
   */
  private syncMissedChanges(state: WatcherState): void {
    debugLog('syncMissedChanges START', { projectId: state.projectId });
    if (!this.incrementalParseHandler) {
      debugLog('syncMissedChanges: no handler, skipping', {});
      return;
    }

    // The sync is a parse like any other: events that arrive during it wait until it ends.
    state.isProcessing = true;
    this.incrementalParseHandler(state.projectPath, state.projectId, state.tsconfigPath)
      .then((result) => {
        debugLog('syncMissedChanges: completed', {
          projectId: state.projectId,
          nodesUpdated: result.nodesUpdated,
          edgesUpdated: result.edgesUpdated,
        });
        if (result.nodesUpdated > 0 || result.edgesUpdated > 0) {
          console.error(
            `[WatchManager] Synced missed changes for ${state.projectId}: ` +
              `${result.nodesUpdated} nodes, ${result.edgesUpdated} edges`,
          );
        }
      })
      .catch((error) => {
        debugLog('syncMissedChanges: error', {
          projectId: state.projectId,
          error: String(error),
          isStopping: state.isStopping,
        });
        // Only log if watcher hasn't been stopped
        if (!state.isStopping) {
          console.error(`[WatchManager] Failed to sync missed changes for ${state.projectId}:`, error);
        }
      })
      .finally(() => {
        debugLog('syncMissedChanges END', { projectId: state.projectId });
        this.finishParse(state);
      });
  }

  /**
   * Stop watching a project
   * Waits for any in-progress processing to complete before cleanup
   */
  async stopWatching(projectId: string): Promise<boolean> {
    const state = this.watchers.get(projectId);
    if (!state) {
      return false;
    }

    // Mark as stopping to prevent new event processing
    state.isStopping = true;
    state.status = 'paused';

    // Clear debounce timer
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }

    // Wait for any in-progress processing to complete (with timeout)
    const maxWaitMs = 30000; // 30 second timeout
    const startTime = Date.now();
    while (state.isProcessing && Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Unsubscribe from @parcel/watcher (only if subscription exists)
    if (state.subscription) {
      try {
        await state.subscription.unsubscribe();
      } catch (error) {
        console.warn(`[WatchManager] Error unsubscribing watcher for ${projectId}:`, error);
      }
    }

    this.watchers.delete(projectId);

    console.error(`[WatchManager] Stopped watching project: ${projectId}`);

    return true;
  }

  /**
   * Get watcher info for a project
   */
  getWatcherInfo(projectId: string): WatcherInfo | undefined {
    const state = this.watchers.get(projectId);
    if (!state) return undefined;
    return this.getWatcherInfoFromState(state);
  }

  /**
   * List all active watchers
   */
  listWatchers(): WatcherInfo[] {
    return Array.from(this.watchers.values()).map((state) => this.getWatcherInfoFromState(state));
  }

  /**
   * Stop all watchers (for shutdown)
   */
  async stopAllWatchers(): Promise<void> {
    const projectIds = Array.from(this.watchers.keys());
    await Promise.all(projectIds.map((id) => this.stopWatching(id)));
    console.error(`[WatchManager] Stopped all ${projectIds.length} watchers`);
  }

  /**
   * Convert internal state to public info
   */
  private getWatcherInfoFromState(state: WatcherState): WatcherInfo {
    return {
      projectId: state.projectId,
      projectPath: state.projectPath,
      status: state.status,
      lastUpdateTime: state.lastUpdateTime?.toISOString() ?? null,
      pendingChanges: state.pendingEvents.length,
      debounceMs: state.config.debounceMs,
      errorMessage: state.errorMessage,
    };
  }
}

// Singleton instance
export const watchManager = new WatchManager();
