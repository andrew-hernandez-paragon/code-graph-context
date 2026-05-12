/**
 * DeliberateWatchManager
 * Manages fs-watch subscriptions over deliberation.jsonl.
 * Mirrors the shape of CursordiffWatchManager but is purpose-built for the
 * single deliberation JSONL file.
 */

import { closeSync, openSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import * as parcelWatcher from '@parcel/watcher';
import type { AsyncSubscription } from '@parcel/watcher';

import { planIngestDeliberate } from '../../ingestors/deliberate/index.js';
import { ensureProjectNode, isSyntheticProjectId } from '../../core/utils/project-id.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { debugLog } from '../utils.js';

export const DEFAULT_DELIBERATE_DATA_DIR = join(homedir(), '.local/share/nvim/cursordiff');
const DEBOUNCE_MS = 500;

interface FileCursor {
  path: string;
  offset: number;
  inode: number | null;
  size: number;
}

export interface DeliberateWatcherRecord {
  watchId: string;
  dataDir: string;
  deliberationFile: string;
  dryRun: boolean;
  tailOnly: boolean;
  subscription: AsyncSubscription | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  isProcessing: boolean;
  isStopping: boolean;
  rowsProcessed: number;
  lastActivityAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  cursor: FileCursor;
}

export interface DeliberateWatcherInfo {
  watchId: string;
  dataDir: string;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  rowsProcessed: number;
  isProcessing: boolean;
}

const readNewText = (cursor: FileCursor): string => {
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(cursor.path);
  } catch {
    return '';
  }

  const currentInode = st.ino;
  const currentSize = st.size;

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

class DeliberateWatchManager {
  private watchers: Map<string, DeliberateWatcherRecord> = new Map();

  listWatchers(): DeliberateWatcherInfo[] {
    return Array.from(this.watchers.values()).map((r) => this.toInfo(r));
  }

  getWatcher(idOrDir: string): DeliberateWatcherInfo | undefined {
    const rec = this.watchers.get(idOrDir) ?? this.findByDataDir(idOrDir);
    return rec ? this.toInfo(rec) : undefined;
  }

  isWatching(dataDir: string): DeliberateWatcherRecord | undefined {
    return this.findByDataDir(dataDir);
  }

  async startWatching(opts: {
    dataDir: string;
    deliberationFile: string;
    dryRun: boolean;
    tailOnly: boolean;
  }): Promise<DeliberateWatcherRecord> {
    const existing = this.findByDataDir(opts.dataDir);
    if (existing) return existing;

    const watchId = `delib-${Date.now()}`;
    const deliberationPath = join(opts.dataDir, opts.deliberationFile);

    const rec: DeliberateWatcherRecord = {
      watchId,
      dataDir: opts.dataDir,
      deliberationFile: opts.deliberationFile,
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
      cursor: makeCursor(deliberationPath, opts.tailOnly),
    };

    try {
      const subscription = await parcelWatcher.subscribe(opts.dataDir, (err, _events) => {
        if (err) {
          rec.lastError = err.message;
          rec.lastErrorAt = new Date();
          debugLog('deliberate watcher error', { watchId, error: err.message });
          return;
        }
        this.scheduleIngest(rec);
      });

      rec.subscription = subscription;
      this.watchers.set(watchId, rec);

      await debugLog('deliberate watcher started', { watchId, dataDir: opts.dataDir });
      return rec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await debugLog('deliberate watcher failed to start', { watchId, error: msg });
      throw err;
    }
  }

  async stopWatching(idOrDir: string): Promise<boolean> {
    const rec = this.watchers.get(idOrDir) ?? this.findByDataDir(idOrDir);
    if (!rec) return false;

    rec.isStopping = true;
    if (rec.debounceTimer) {
      clearTimeout(rec.debounceTimer);
      rec.debounceTimer = null;
    }

    const deadline = Date.now() + 15_000;
    while (rec.isProcessing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (rec.subscription) {
      try {
        await rec.subscription.unsubscribe();
      } catch (e) {
        console.warn('[DeliberateWatchManager] unsubscribe error:', e);
      }
    }

    this.watchers.delete(rec.watchId);
    await debugLog('deliberate watcher stopped', { watchId: rec.watchId });
    return true;
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    await Promise.all(ids.map((id) => this.stopWatching(id)));
  }

  private findByDataDir(dataDir: string): DeliberateWatcherRecord | undefined {
    for (const rec of this.watchers.values()) {
      if (rec.dataDir === dataDir) return rec;
    }
    return undefined;
  }

  private toInfo(rec: DeliberateWatcherRecord): DeliberateWatcherInfo {
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

  private scheduleIngest(rec: DeliberateWatcherRecord): void {
    if (rec.isStopping) return;
    if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
    rec.debounceTimer = setTimeout(() => {
      this.runIngest(rec).catch((err) => {
        console.error('[DeliberateWatchManager] ingest error:', err);
      });
    }, DEBOUNCE_MS);
  }

  private async runIngest(rec: DeliberateWatcherRecord): Promise<void> {
    if (rec.isProcessing || rec.isStopping) return;
    rec.isProcessing = true;
    rec.debounceTimer = null;

    try {
      const newText = readNewText(rec.cursor);
      const newRows = newText.split('\n').filter((l) => l.trim()).length;
      if (newRows === 0) return;

      // Re-run planIngestDeliberate over full file — idempotent via MERGEs.
      const { emits, projectIds, stats } = planIngestDeliberate({ dataDir: rec.dataDir });

      if (rec.dryRun) {
        rec.rowsProcessed += newRows;
        rec.lastActivityAt = new Date();
        await debugLog('deliberate ingest (dry-run)', { watchId: rec.watchId, newRows, emits: emits.length });
        return;
      }

      const neo4j = new Neo4jService();
      try {
        // Ensure Project nodes exist for every projectId referenced
        for (const projectId of projectIds) {
          await ensureProjectNode(neo4j, projectId, { synthetic: isSyntheticProjectId(projectId) });
        }

        for (const e of emits) {
          await neo4j.run(e.query, e.params as Record<string, unknown>);
        }
      } finally {
        await neo4j.close();
      }

      rec.rowsProcessed += newRows;
      rec.lastActivityAt = new Date();
      await debugLog('deliberate ingest complete', { watchId: rec.watchId, newRows, emits: emits.length, stats });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rec.lastError = msg;
      rec.lastErrorAt = new Date();
      console.error('[DeliberateWatchManager] ingest failed:', msg);
    } finally {
      rec.isProcessing = false;
    }
  }
}

export const deliberateWatchManager = new DeliberateWatchManager();
