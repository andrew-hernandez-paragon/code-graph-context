/**
 * CursordiffWatchManager
 * Manages fs-watch subscriptions over cursordiff JSONL files.
 * Mirrors the shape of WatchManager but is purpose-built for the three
 * cursordiff files (router / lineage / decisions) rather than TypeScript
 * source trees.
 */

import { closeSync, openSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import * as parcelWatcher from '@parcel/watcher';
import type { AsyncSubscription } from '@parcel/watcher';

import { planIngest } from '../../ingestors/cursordiff/index.js';
import { DecisionRow, LineageRow, RouterRow } from '../../ingestors/cursordiff/read-jsonl.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { debugLog } from '../utils.js';

export const DEFAULT_DATA_DIR = join(homedir(), '.local/share/nvim/cursordiff');
const DEBOUNCE_MS = 500;

/** Per-file byte-offset cursor so we read only new rows on each event. */
interface FileCursor {
  path: string;
  offset: number;
  inode: number | null;
  size: number;
}

export interface CursordiffWatcherRecord {
  watchId: string;
  dataDir: string;
  routerFile: string;
  lineageFile: string;
  decisionsFile: string;
  parsedRoots: string[];
  dryRun: boolean;
  tailOnly: boolean;
  subscription: AsyncSubscription | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  isProcessing: boolean;
  isStopping: boolean;
  /** Running totals across all ingest cycles. */
  rowsProcessed: number;
  lastActivityAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  cursors: {
    router: FileCursor;
    lineage: FileCursor;
    decisions: FileCursor;
  };
}

export interface CursordiffWatcherInfo {
  watchId: string;
  dataDir: string;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  rowsProcessed: number;
  isProcessing: boolean;
}

/**
 * Read new text from a file since the last known cursor position.
 * Handles rotation / truncation by resetting to 0 when the file is smaller.
 */
const readNewText = (cursor: FileCursor): string => {
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(cursor.path);
  } catch {
    return '';
  }

  const currentInode = st.ino;
  const currentSize = st.size;

  // Rotation or truncation — reset cursor
  if (cursor.inode !== null && (currentInode !== cursor.inode || currentSize < cursor.offset)) {
    cursor.offset = 0;
  }
  cursor.inode = currentInode;
  cursor.size = currentSize;

  if (currentSize <= cursor.offset) return '';

  try {
    const buf = Buffer.allocUnsafe(currentSize - cursor.offset);
    const fd = openSync(cursor.path, 'r');
    readSync(fd, buf, 0, buf.length, cursor.offset);
    closeSync(fd);
    cursor.offset = currentSize;
    return buf.toString('utf-8');
  } catch {
    return '';
  }
};

/**
 * Parse JSONL text into typed rows, tolerating malformed lines.
 */
const parseJsonlText = <T>(text: string): T[] => {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // tolerate malformed lines
    }
  }
  return out;
};

/**
 * Build initial FileCursor for a path.
 * If tailOnly is true, start at current EOF so we skip existing rows.
 */
const makeCursor = (path: string, tailOnly: boolean): FileCursor => {
  let offset = 0;
  let inode: number | null = null;
  let size = 0;
  try {
    const st = statSync(path);
    inode = st.ino;
    size = st.size;
    if (tailOnly) offset = st.size;
  } catch {
    // file doesn't exist yet — cursor stays at 0
  }
  return { path, offset, inode, size };
};

class CursordiffWatchManager {
  private watchers: Map<string, CursordiffWatcherRecord> = new Map();

  /** Return info snapshot for all active watchers. */
  listWatchers(): CursordiffWatcherInfo[] {
    return Array.from(this.watchers.values()).map((r) => this.toInfo(r));
  }

  /** Return info for a single watcher by watchId or dataDir. */
  getWatcher(idOrDir: string): CursordiffWatcherInfo | undefined {
    const rec = this.watchers.get(idOrDir) ?? this.findByDataDir(idOrDir);
    return rec ? this.toInfo(rec) : undefined;
  }

  /** Check whether a dataDir is already being watched. */
  isWatching(dataDir: string): CursordiffWatcherRecord | undefined {
    return this.findByDataDir(dataDir);
  }

  /**
   * Start watching a dataDir. Returns the existing record if already active.
   */
  async startWatching(opts: {
    dataDir: string;
    routerFile: string;
    lineageFile: string;
    decisionsFile: string;
    parsedRoots: string[];
    dryRun: boolean;
    tailOnly: boolean;
  }): Promise<CursordiffWatcherRecord> {
    const existing = this.findByDataDir(opts.dataDir);
    if (existing) return existing;

    const watchId = `cdiff-${Date.now()}`;
    const routerPath = join(opts.dataDir, opts.routerFile);
    const lineagePath = join(opts.dataDir, opts.lineageFile);
    const decisionsPath = join(opts.dataDir, opts.decisionsFile);

    const rec: CursordiffWatcherRecord = {
      watchId,
      dataDir: opts.dataDir,
      routerFile: opts.routerFile,
      lineageFile: opts.lineageFile,
      decisionsFile: opts.decisionsFile,
      parsedRoots: opts.parsedRoots,
      dryRun: opts.dryRun,
      tailOnly: opts.tailOnly,
      subscription: null,
      debounceTimer: null,
      isProcessing: false,
      isStopping: false,
      rowsProcessed: 0,
      lastActivityAt: null,
      lastErrorAt: null,
      lastError: null,
      cursors: {
        router: makeCursor(routerPath, opts.tailOnly),
        lineage: makeCursor(lineagePath, opts.tailOnly),
        decisions: makeCursor(decisionsPath, opts.tailOnly),
      },
    };

    try {
      const subscription = await parcelWatcher.subscribe(opts.dataDir, (err, _events) => {
        if (err) {
          rec.lastError = err.message;
          rec.lastErrorAt = new Date();
          debugLog('cursordiff watcher error', { watchId, error: err.message });
          return;
        }
        this.scheduleIngest(rec);
      });

      rec.subscription = subscription;
      this.watchers.set(watchId, rec);

      await debugLog('cursordiff watcher started', { watchId, dataDir: opts.dataDir });
      return rec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await debugLog('cursordiff watcher failed to start', { watchId, error: msg });
      throw err;
    }
  }

  /** Stop a watcher by watchId or dataDir. Returns false if not found. */
  async stopWatching(idOrDir: string): Promise<boolean> {
    const rec = this.watchers.get(idOrDir) ?? this.findByDataDir(idOrDir);
    if (!rec) return false;

    rec.isStopping = true;
    if (rec.debounceTimer) {
      clearTimeout(rec.debounceTimer);
      rec.debounceTimer = null;
    }

    // Wait for in-flight ingest (up to 15 s)
    const deadline = Date.now() + 15_000;
    while (rec.isProcessing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (rec.subscription) {
      try {
        await rec.subscription.unsubscribe();
      } catch (e) {
        console.warn('[CursordiffWatchManager] unsubscribe error:', e);
      }
    }

    this.watchers.delete(rec.watchId);
    await debugLog('cursordiff watcher stopped', { watchId: rec.watchId });
    return true;
  }

  /** Stop all watchers (server shutdown). */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    await Promise.all(ids.map((id) => this.stopWatching(id)));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findByDataDir(dataDir: string): CursordiffWatcherRecord | undefined {
    for (const rec of this.watchers.values()) {
      if (rec.dataDir === dataDir) return rec;
    }
    return undefined;
  }

  private toInfo(rec: CursordiffWatcherRecord): CursordiffWatcherInfo {
    return {
      watchId: rec.watchId,
      dataDir: rec.dataDir,
      lastActivityAt: rec.lastActivityAt?.toISOString() ?? null,
      lastErrorAt: rec.lastErrorAt?.toISOString() ?? null,
      lastError: rec.lastError,
      rowsProcessed: rec.rowsProcessed,
      isProcessing: rec.isProcessing,
    };
  }

  private scheduleIngest(rec: CursordiffWatcherRecord): void {
    if (rec.isStopping) return;
    if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
    rec.debounceTimer = setTimeout(() => {
      this.runIngest(rec).catch((err) => {
        console.error('[CursordiffWatchManager] ingest error:', err);
      });
    }, DEBOUNCE_MS);
  }

  private async runIngest(rec: CursordiffWatcherRecord): Promise<void> {
    if (rec.isProcessing || rec.isStopping) return;
    rec.isProcessing = true;
    rec.debounceTimer = null;

    try {
      // Read new rows from each file via cursor tracking
      const routerText = readNewText(rec.cursors.router);
      const lineageText = readNewText(rec.cursors.lineage);
      const decisionsText = readNewText(rec.cursors.decisions);

      const routerRows = parseJsonlText<RouterRow>(routerText);
      const lineageRows = parseJsonlText<LineageRow>(lineageText);
      const decisionRows = parseJsonlText<DecisionRow>(decisionsText);

      const newRows = routerRows.length + lineageRows.length + decisionRows.length;
      if (newRows === 0) return;

      // Re-run planIngest over full files so cross-references resolve correctly.
      // planIngest is cheap (in-memory) and always idempotent (all writes are MERGEs).
      const { emits, stats } = planIngest({
        dataDir: rec.dataDir,
        parsedRoots: rec.parsedRoots,
      });

      if (rec.dryRun) {
        rec.rowsProcessed += newRows;
        rec.lastActivityAt = new Date();
        await debugLog('cursordiff ingest (dry-run)', { watchId: rec.watchId, newRows, emits: emits.length });
        return;
      }

      const neo4j = new Neo4jService();
      try {
        for (const e of emits) {
          await neo4j.run(e.query, e.params as Record<string, unknown>);
        }
      } finally {
        await neo4j.close();
      }

      rec.rowsProcessed += newRows;
      rec.lastActivityAt = new Date();
      await debugLog('cursordiff ingest complete', {
        watchId: rec.watchId,
        newRows,
        emits: emits.length,
        stats,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rec.lastError = msg;
      rec.lastErrorAt = new Date();
      console.error('[CursordiffWatchManager] ingest failed:', msg);
    } finally {
      rec.isProcessing = false;
    }
  }
}

export const cursordiffWatchManager = new CursordiffWatchManager();
