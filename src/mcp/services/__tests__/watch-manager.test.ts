import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { IncrementalParseHandler } from '../watch-manager.js';

interface FileEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

const { parcel } = vi.hoisted(() => ({
  parcel: {
    emit: undefined as unknown as (events: FileEvent[]) => void,
    ignore: undefined as unknown as string[],
  },
}));

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(
    async (_directory: string, onEvents: (error: Error | null, events: FileEvent[]) => void, options) => {
      parcel.emit = (events) => onEvents(null, events);
      parcel.ignore = options.ignore;
      return { unsubscribe: vi.fn() };
    },
  ),
}));
vi.mock('../../utils.js', () => ({ debugLog: vi.fn() }));

const WATCHED = {
  projectPath: '/work/lab',
  projectId: 'proj_lab',
  tsconfigPath: '/work/lab/tsconfig.json',
  debounceMs: 1000,
};
const edit = (file: string): FileEvent[] => [{ type: 'update', path: `/work/lab/src/${file}` }];

describe('WatchManager', () => {
  let watchManager: typeof import('../watch-manager.js').watchManager;
  let finishParse: Array<() => void>;
  let parse: Mock<IncrementalParseHandler>;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    finishParse = [];
    parse = vi.fn<IncrementalParseHandler>(
      () =>
        new Promise<{ nodesUpdated: number; edgesUpdated: number }>((resolve) => {
          finishParse.push(() => resolve({ nodesUpdated: 1, edgesUpdated: 1 }));
        }),
    );
    ({ watchManager } = await import('../watch-manager.js'));
    watchManager.setIncrementalParseHandler(parse);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Starts the watcher and lets its startup sync, the first parse, finish. */
  const startWatchingWithSyncDone = async () => {
    await watchManager.startWatching(WATCHED);
    finishParse[0]();
    await settle();
  };

  it('parses a change that arrived during a parse as soon as that parse ends', async () => {
    await startWatchingWithSyncDone();
    parcel.emit(edit('first.ts'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(parse).toHaveBeenCalledTimes(2);

    parcel.emit(edit('late.ts'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(parse).toHaveBeenCalledTimes(2);

    finishParse[1]();
    await settle();

    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('leaves a change that is still inside its debounce window to its own timer', async () => {
    await startWatchingWithSyncDone();
    parcel.emit(edit('first.ts'));
    await vi.advanceTimersByTimeAsync(1000);

    parcel.emit(edit('late.ts'));
    await vi.advanceTimersByTimeAsync(400);
    finishParse[1]();
    await settle();
    expect(parse).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(600);

    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('holds a change that arrives during the startup sync until the sync ends', async () => {
    await watchManager.startWatching(WATCHED);
    parcel.emit(edit('early.ts'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(parse).toHaveBeenCalledTimes(1);

    finishParse[0]();
    await settle();

    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('ignores the paths the parser never indexes, so editing them starts no parse', async () => {
    await watchManager.startWatching(WATCHED);

    expect(parcel.ignore).toEqual([
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/jest.config.ts',
      '**/*-e2e/**',
      '**/test-setup.ts',
      '**/global-setup.ts',
      '**/global-teardown.ts',
      '**/.git/**',
      '**/*.js',
      '**/*.map',
    ]);
  });

  it('parses nothing after a parse that no change followed', async () => {
    await startWatchingWithSyncDone();
    parcel.emit(edit('only.ts'));
    await vi.advanceTimersByTimeAsync(1000);
    finishParse[1]();
    await vi.advanceTimersByTimeAsync(5000);

    expect(parse).toHaveBeenCalledTimes(2);
  });
});
