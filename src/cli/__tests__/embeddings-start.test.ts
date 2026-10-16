import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerProbe } from '../../core/embeddings/embedding-server-launch.js';
import { EmbeddingsStartDependencies, runEmbeddingsStart } from '../embeddings-start.js';

const logPath = join(mkdtempSync(join(tmpdir(), 'cgc-embeddings-start-')), 'sidecar.log');

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const healthy: ServerProbe = { state: 'healthy', model: 'BAAI/bge-base-en-v1.5', dimensions: 768 };
const absent: ServerProbe = { state: 'absent' };

let child: FakeChild;
let stdout: string[];
let stderr: string[];
let probe: ReturnType<typeof vi.fn<EmbeddingsStartDependencies['probe']>>;
let launch: ReturnType<typeof vi.fn<EmbeddingsStartDependencies['launch']>>;
let sleep: ReturnType<typeof vi.fn<EmbeddingsStartDependencies['sleep']>>;

const run = () =>
  runEmbeddingsStart({
    config: {
      port: 8787,
      host: '127.0.0.1',
      model: 'BAAI/bge-base-en-v1.5',
      startupTimeoutMs: 3000,
      requestTimeoutMs: 1000,
      idleTimeoutS: 600,
    },
    logPath,
    probe,
    launch,
    sleep,
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });

beforeEach(() => {
  child = new FakeChild();
  stdout = [];
  stderr = [];
  probe = vi.fn();
  launch = vi.fn(() => child as unknown as ChildProcess);
  sleep = vi.fn(async () => {});
});

describe('embeddings start', () => {
  it('exits 0 without spawning when the server is already healthy', async () => {
    probe.mockResolvedValueOnce(healthy);

    expect(await run()).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    expect(stdout).toEqual(['Embedding server ready: model BAAI/bge-base-en-v1.5, port 8787']);
    expect(stderr).toEqual([]);
  });

  it('spawns a detached server that ignores its parent, then exits 0 once it is healthy', async () => {
    probe.mockResolvedValueOnce(absent).mockResolvedValueOnce({ state: 'loading' }).mockResolvedValueOnce(healthy);

    expect(await run()).toBe(0);
    expect(launch).toHaveBeenCalledTimes(1);
    const options = launch.mock.calls[0][0];
    expect(options).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      model: 'BAAI/bge-base-en-v1.5',
      idleTimeoutS: 600,
      watchParent: false,
      detached: true,
    });
    expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(child.unref).toHaveBeenCalled();
    expect(stdout).toEqual(['Embedding server ready: model BAAI/bge-base-en-v1.5, port 8787']);
  });

  it('waits for a server that is still loading without spawning another', async () => {
    probe.mockResolvedValueOnce({ state: 'loading' }).mockResolvedValueOnce(healthy);

    expect(await run()).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it('exits 1 naming the log path when the child exits early', async () => {
    probe.mockResolvedValue(absent);
    sleep.mockImplementationOnce(async () => {
      child.emit('exit', 1, null);
    });

    expect(await run()).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `Embedding server not ready: server process exited during startup (code=1, signal=null). See ${logPath}`,
    ]);
  });

  it('exits 1 when the server never becomes healthy within the startup timeout', async () => {
    probe.mockResolvedValue({ state: 'loading' });

    expect(await run()).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(stderr).toEqual([`Embedding server not ready: not healthy within 3000ms. See ${logPath}`]);
  });
});
