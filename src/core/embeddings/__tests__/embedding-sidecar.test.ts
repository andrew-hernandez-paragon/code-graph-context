import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readIdleTimeoutS } from '../embedding-server-launch.js';
import { EmbeddingSidecar } from '../embedding-sidecar.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, 'SIGTERM'));
    return true;
  });
  exitOnItsOwn(): void {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

let servers: FakeChild[];
const serverSpawns = () => spawnMock.mock.calls.filter(([, args]) => args[0] === '-m');

const model = 'BAAI/bge-base-en-v1.5';
const fetchMock = vi.fn();
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const health = (override = {}) => response({ status: 'ok', model, dimensions: 768, ...override });
const embedding = (override = {}) =>
  response({ model, dimensions: 768, embeddings: [Array(768).fill(0.1)], ...override });

beforeEach(() => {
  servers = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = new FakeChild();
    if (args[0] === '--version') {
      queueMicrotask(() => child.emit('close', 0));
    } else {
      servers.push(child);
    }
    return child;
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sidecar model consistency', () => {
  it('reuses an external sidecar only when its model and dimensions match', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(embedding());
    const sidecar = new EmbeddingSidecar({ model });
    try {
      expect(await sidecar.embed(['code'])).toHaveLength(1);
      expect(sidecar.dimensions).toBe(768);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await sidecar.stop();
    }
  });

  it.each([
    { model: 'codesage/codesage-base-v2', dimensions: 1024 },
    { model: 'sentence-transformers/all-mpnet-base-v2', dimensions: 768 },
    { model: undefined },
    { dimensions: 1024 },
    { dimensions: undefined },
  ])('rejects incompatible health metadata %j before embedding', async (metadata) => {
    fetchMock.mockResolvedValueOnce(health(metadata));
    const sidecar = new EmbeddingSidecar({ model });
    await expect(sidecar.embed(['code'])).rejects.toThrow(/expected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('detects a different model replacing the server after startup', async () => {
    fetchMock
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(embedding())
      .mockResolvedValueOnce(embedding({ model: 'sentence-transformers/all-mpnet-base-v2' }));
    const sidecar = new EmbeddingSidecar({ model });
    try {
      await sidecar.embed(['first']);
      await expect(sidecar.embed(['second'])).rejects.toThrow(/expected BAAI/);
    } finally {
      await sidecar.stop();
    }
  });

  it.each([{ embeddings: [] }, { embeddings: [Array(1024).fill(0)] }])(
    'rejects inconsistent vector payloads %j',
    async (metadata) => {
      fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(embedding(metadata));
      const sidecar = new EmbeddingSidecar({ model });
      try {
        await expect(sidecar.embed(['code'])).rejects.toThrow(/inconsistent/);
      } finally {
        await sidecar.stop();
      }
    },
  );

  it('returns no vectors for an empty batch without starting a server', async () => {
    expect(await new EmbeddingSidecar({ model }).embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const refused = () => new TypeError('fetch failed');
const loading = () => new Response('{}', { status: 503 });

describe('sidecar lifetime', () => {
  it('launches the server with idle shutdown and parent watch, and keeps no idle timer of its own', async () => {
    fetchMock.mockRejectedValueOnce(refused()).mockResolvedValueOnce(health()).mockResolvedValueOnce(embedding());
    const sidecar = new EmbeddingSidecar({ model, idleTimeoutS: 600 });
    await sidecar.embed(['code']);

    const [, , options] = serverSpawns()[0];
    expect(options.env.EMBEDDING_IDLE_TIMEOUT_S).toBe('600');
    expect(options.env.EMBEDDING_WATCH_PARENT).toBe('1');
    expect(options.detached).toBe(false);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(servers[0].kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    await sidecar.stop();
  });

  it('starts the server again when its child process has exited', async () => {
    fetchMock
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(embedding())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(embedding());
    const sidecar = new EmbeddingSidecar({ model });
    await sidecar.embed(['first']);
    servers[0].exitOnItsOwn();
    await sidecar.embed(['second']);

    expect(serverSpawns()).toHaveLength(2);
    await sidecar.stop();
  });

  it('starts the server when a foreign server that answered earlier stops answering', async () => {
    fetchMock
      .mockResolvedValueOnce(health())
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(embedding());
    const sidecar = new EmbeddingSidecar({ model });

    expect(await sidecar.embed(['code'])).toHaveLength(1);
    expect(serverSpawns()).toHaveLength(1);
    await sidecar.stop();
  });

  it('does not retry an HTTP error response', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const sidecar = new EmbeddingSidecar({ model });

    await expect(sidecar.embed(['code'])).rejects.toThrow(/\(500\): boom/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(serverSpawns()).toHaveLength(0);
  });

  it('waits for a server that is still loading instead of spawning a second one', async () => {
    fetchMock.mockResolvedValueOnce(loading()).mockResolvedValueOnce(health()).mockResolvedValueOnce(embedding());
    const sidecar = new EmbeddingSidecar({ model });

    expect(await sidecar.embed(['code'])).toHaveLength(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('readIdleTimeoutS', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { seconds: '30', millis: '9000', expected: 30 },
    { seconds: '', millis: '90000', expected: 90 },
    { seconds: '0', millis: '', expected: 0 },
    { seconds: '', millis: '', expected: 600 },
  ])('reads seconds $seconds / millis $millis as $expected', ({ seconds, millis, expected }) => {
    vi.stubEnv('EMBEDDING_IDLE_TIMEOUT_S', seconds);
    vi.stubEnv('EMBEDDING_IDLE_TIMEOUT_MS', millis);
    expect(readIdleTimeoutS()).toBe(expected);
  });
});

describe('sidecar rerank', () => {
  it('returns one score per text from a sidecar that reranks', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(response({ scores: [0.9, 0.1], model: 'r' }));
    const sidecar = new EmbeddingSidecar({ model });

    expect(await sidecar.rerank('q', ['a', 'b'])).toEqual([0.9, 0.1]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ query: 'q', texts: ['a', 'b'] });
  });

  it('returns null, so the caller keeps its own order, from a sidecar without /rerank', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    expect(await new EmbeddingSidecar({ model }).rerank('q', ['a'])).toBeNull();
  });

  it('returns null when the score list does not match the texts', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(response({ scores: [0.9] }));

    expect(await new EmbeddingSidecar({ model }).rerank('q', ['a', 'b'])).toBeNull();
  });
});
