import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSidecarPython, resolveSidecarVenvDir, venvPythonPath } from '../sidecar-venv.js';

describe('sidecar venv location', () => {
  it('lives under the data directory', () => {
    expect(resolveSidecarVenvDir({ CGC_DATA_DIR: '/data/cgc' })).toBe('/data/cgc/sidecar-venv');
  });

  it('defaults to ~/.local/share/code-graph-context', () => {
    expect(resolveSidecarVenvDir({})).toMatch(/\/\.local\/share\/code-graph-context\/sidecar-venv$/);
  });

  it('points at the platform python inside a venv', () => {
    expect(venvPythonPath('/v', 'linux')).toBe('/v/bin/python3');
    expect(venvPythonPath('/v', 'win32')).toBe(join('/v', 'Scripts', 'python.exe'));
  });
});

describe('resolveSidecarPython', () => {
  let root: string;
  let venvDir: string;
  let legacyVenvDir: string;

  const createVenv = (dir: string): string => {
    const python = venvPythonPath(dir, 'linux');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(python, '');
    return python;
  };
  const resolve = (env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux'): string =>
    resolveSidecarPython({ env, platform, venvDir, legacyVenvDir, exists: existsSync });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sidecar-venv-'));
    venvDir = join(root, 'data', 'sidecar-venv');
    legacyVenvDir = join(root, 'package', 'sidecar', '.venv');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('prefers PYTHON_EXECUTABLE over every venv', () => {
    createVenv(venvDir);
    createVenv(legacyVenvDir);
    expect(resolve({ PYTHON_EXECUTABLE: '/custom/python' })).toBe('/custom/python');
  });

  it('prefers the data directory venv over the legacy venv', () => {
    const python = createVenv(venvDir);
    createVenv(legacyVenvDir);
    expect(resolve()).toBe(python);
  });

  it('uses the legacy venv when the data directory has none', () => {
    const python = createVenv(legacyVenvDir);
    expect(resolve()).toBe(python);
  });

  it('falls back to system python', () => {
    expect(resolve()).toBe('python3');
    expect(resolve({}, 'win32')).toBe('python');
  });
});
