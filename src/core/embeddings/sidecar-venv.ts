import { join } from 'path';

import { resolveDataDirectory } from '../utils/data-directory.js';

export interface SidecarPythonLocations {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Virtualenv outside the package, which survives `npm i -g`. */
  venvDir: string;
  /** Virtualenv inside the installed package, created by releases before the data directory. */
  legacyVenvDir: string;
  exists: (path: string) => boolean;
}

export const resolveSidecarVenvDir = (env: NodeJS.ProcessEnv): string =>
  join(resolveDataDirectory(env), 'sidecar-venv');

export const venvPythonPath = (venvDir: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python3');

/** PYTHON_EXECUTABLE, then the sidecar venv, then the legacy in-package venv, then system python. */
export const resolveSidecarPython = ({
  env,
  platform,
  venvDir,
  legacyVenvDir,
  exists,
}: SidecarPythonLocations): string => {
  if (env.PYTHON_EXECUTABLE) return env.PYTHON_EXECUTABLE;
  for (const dir of [venvDir, legacyVenvDir]) {
    const python = venvPythonPath(dir, platform);
    if (exists(python)) return python;
  }
  return platform === 'win32' ? 'python' : 'python3';
};
