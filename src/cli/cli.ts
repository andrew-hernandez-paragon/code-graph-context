#!/usr/bin/env node
/**
 * CLI Entry Point for Code Graph Context
 *
 * Handles CLI commands (init, status, stop) and delegates to MCP server
 */

import { execSync, spawn as spawnProcess } from 'child_process';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { Command } from 'commander';

import { getLocalEmbeddingModel } from '../core/embeddings/embedding-config.js';
import { LEGACY_SIDECAR_VENV_DIR } from '../core/embeddings/embedding-server-launch.js';
import { resolveSidecarVenvDir, venvPythonPath } from '../core/embeddings/sidecar-venv.js';
import { ProjectDeletionService, ProjectService } from '../core/projects/index.js';
import { resolveDataDirectory } from '../core/utils/data-directory.js';
import { readPackageVersion } from '../core/utils/package-version.js';
import { Neo4jConnection, getNeo4jConnection } from '../storage/neo4j/neo4j-connection.js';
import { parseNeo4jVersion, supportsProjectFilteredSearch } from '../storage/neo4j/neo4j-version.js';
import { Neo4jService } from '../storage/neo4j/neo4j.service.js';

import { ProcessCommandRunner } from './command-runner.js';
import { runEmbeddingsStart } from './embeddings-start.js';
import { Neo4jBoltClient, NodeMigrationFileSystem, SystemClock } from './migrate-from-docker-adapters.js';
import { MigrateFromDockerOptions, runMigrateFromDocker } from './migrate-from-docker.js';
import { createMigrationEnvironment } from './migration-environment.js';
import { isApocAvailable, probeBolt, queryBolt, waitForApoc, waitForBolt } from './neo4j-bolt.js';
import {
  NEO4J_CONFIG,
  createContainer,
  getContainerImage,
  getContainerPublishedPorts,
  getContainerStatus,
  getFullStatus,
  isDockerInstalled,
  isDockerRunning,
  removeContainer,
  startContainer,
  stopContainer,
} from './neo4j-docker.js';
import { NativeNeo4jProvider, createNativeNeo4jProvider } from './neo4j-native.js';
import { Neo4jProviderName, readProviderRecord, writeProviderRecord } from './neo4j-provider-record.js';
import { ProjectDeleteOptions, confirmOnTerminal, runProjectDelete } from './project-delete.js';
import { selectNeo4jProvider } from './select-neo4j-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

const sym = {
  ok: `${c.green}✓${c.reset}`,
  err: `${c.red}✗${c.reset}`,
  warn: `${c.yellow}⚠${c.reset}`,
  info: `${c.blue}ℹ${c.reset}`,
} as const;

const log = (symbol: string, msg: string): void => {
  console.log(`  ${symbol} ${msg}`);
};

const header = (text: string): void => {
  console.log(`\n${c.bold}${text}${c.reset}\n`);
};

/**
 * Spinner for async operations
 */
const spinner = (msg: string): { stop: (ok: boolean, finalMsg?: string) => void } => {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${c.blue}${frames[i]}${c.reset} ${msg}`);
    i = (i + 1) % frames.length;
  }, 80);

  return {
    stop: (ok: boolean, finalMsg?: string) => {
      clearInterval(interval);
      process.stdout.write(`\r  ${ok ? sym.ok : sym.err} ${finalMsg ?? msg}\n`);
    },
  };
};

/**
 * Print config instructions
 */
const printConfigInstructions = (password: string, boltPort: number): void => {
  console.log(`
${c.bold}Next steps:${c.reset}

  1. Add to Claude Code:
     ${c.dim}claude mcp add code-graph-context code-graph-context${c.reset}

  2. Configure in ${c.cyan}~/.config/claude/config.json${c.reset}:

     ${c.dim}{
       "mcpServers": {
         "code-graph-context": {
           "command": "code-graph-context",
           "env": {${
             password !== NEO4J_CONFIG.defaultPassword
               ? `
             "NEO4J_PASSWORD": "${password}"${boltPort !== NEO4J_CONFIG.boltPort ? ',' : ''}`
               : ''
           }${
             boltPort !== NEO4J_CONFIG.boltPort
               ? `
             "NEO4J_URI": "bolt://localhost:${boltPort}"`
               : ''
           }
           }
         }
       }
     }${c.reset}

     ${c.dim}Local embeddings are used by default (no API key needed).
     To use OpenAI instead, add:
       "OPENAI_EMBEDDINGS_ENABLED": "true",
       "OPENAI_API_KEY": "sk-..."${c.reset}

  3. Restart Claude Code
`);
};

/**
 * Resolve the sidecar directory (works from both src/ and dist/)
 */
const getSidecarDir = (): string => join(__dirname, '..', '..', 'sidecar');

/**
 * Get the best python binary to use for the sidecar.
 * Prefers the venv python, falls back to system python3.
 */
const getSidecarPython = (): string => {
  const venvPython = venvPythonPath(resolveSidecarVenvDir(process.env), process.platform);
  return existsSync(venvPython) ? venvPython : 'python3';
};

/**
 * Check if python3 is available and return its version
 */
const getPythonVersion = (): string | null => {
  try {
    return execSync('python3 --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};

/**
 * Check if a pip package is importable using the sidecar python
 */
const checkPipPackage = (pkg: string, python: string = 'python3'): boolean => {
  try {
    execSync(`${python} -c "import ${pkg}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
};

/**
 * Create the sidecar venv in the data directory
 */
const createVenv = (venvPath: string): boolean => {
  try {
    mkdirSync(dirname(venvPath), { recursive: true });
    execSync(`python3 -m venv "${venvPath}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
};

/**
 * Install sidecar Python dependencies via pip inside the venv
 */
const installSidecarDeps = (sidecarDir: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const requirementsPath = join(sidecarDir, 'requirements.txt');
    // `python -m pip`, because a moved venv keeps absolute shebangs in bin/pip pointing at the old path.
    const pip = spawnProcess(getSidecarPython(), ['-m', 'pip', 'install', '-r', requirementsPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    pip.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && (line.includes('Downloading') || line.includes('Installing') || line.includes('ERROR'))) {
        process.stdout.write(`\r  ${c.blue}⠸${c.reset} ${line.slice(0, 70).padEnd(70)}`);
      }
    });

    pip.on('close', (code) => {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      resolve(code === 0);
    });

    pip.on('error', () => {
      resolve(false);
    });
  });
};

/**
 * Verify sentence-transformers can be imported using the venv python
 */
const verifySidecar = (sidecarDir: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const python = getSidecarPython();
    const test = spawnProcess(
      python,
      [
        '-c',
        `import transformers.modeling_utils as _mu; hasattr(_mu,"Conv1D") or setattr(_mu,"Conv1D",__import__("transformers.pytorch_utils",fromlist=["Conv1D"]).Conv1D); from sentence_transformers import SentenceTransformer; print("ok")`,
      ],
      {
        cwd: sidecarDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    test.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    test.on('close', (code) => resolve(code === 0 && stdout.includes('ok')));
    test.on('error', () => resolve(false));
  });
};

/**
 * Move a venv left inside the package by an earlier release to the data directory.
 * A rename only works within one filesystem; otherwise init builds a fresh venv.
 */
const moveLegacyVenv = (venvPath: string): void => {
  if (existsSync(venvPath) || !existsSync(LEGACY_SIDECAR_VENV_DIR)) return;
  try {
    mkdirSync(dirname(venvPath), { recursive: true });
    renameSync(LEGACY_SIDECAR_VENV_DIR, venvPath);
    log(
      sym.ok,
      `Moved the virtual environment from ${c.dim}${LEGACY_SIDECAR_VENV_DIR}${c.reset} to ${c.dim}${venvPath}${c.reset}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(sym.warn, `Could not move the legacy virtual environment (${reason}); creating a new one`);
  }
};

/**
 * Set up the Python embedding sidecar
 */
const setupSidecar = async (): Promise<void> => {
  console.log('');
  header('Embedding Sidecar Setup');

  const sidecarDir = getSidecarDir();

  // Check Python
  const pythonVersion = getPythonVersion();
  if (!pythonVersion) {
    log(sym.err, 'Python 3 is not installed');
    console.log(`\n  Install Python 3.10+: ${c.cyan}https://www.python.org/downloads/${c.reset}`);
    console.log(`  ${c.dim}Or use OpenAI embeddings instead: set OPENAI_EMBEDDINGS_ENABLED=true${c.reset}\n`);
    return;
  }
  log(sym.ok, `${pythonVersion}`);

  // Create or reuse venv
  const venvPath = resolveSidecarVenvDir(process.env);
  moveLegacyVenv(venvPath);
  if (existsSync(venvPath)) {
    log(sym.ok, `Virtual environment exists (${c.dim}${venvPath}${c.reset})`);
  } else {
    const venvSpinner = spinner('Creating virtual environment...');
    const created = createVenv(venvPath);
    if (!created) {
      venvSpinner.stop(false, 'Failed to create virtual environment');
      console.log(`\n  Try manually: ${c.dim}python3 -m venv ${venvPath}${c.reset}\n`);
      return;
    }
    venvSpinner.stop(true, `Virtual environment created (${c.dim}${venvPath}${c.reset})`);
  }

  const python = getSidecarPython();

  // Check if deps already installed in venv
  const hasSentenceTransformers = checkPipPackage('sentence_transformers', python);
  const hasFastApi = checkPipPackage('fastapi', python);
  const hasTorch = checkPipPackage('torch', python);

  if (hasSentenceTransformers && hasFastApi && hasTorch) {
    log(sym.ok, 'Python dependencies already installed');
  } else {
    const missing: string[] = [];
    if (!hasTorch) missing.push('torch');
    if (!hasSentenceTransformers) missing.push('sentence-transformers');
    if (!hasFastApi) missing.push('fastapi');
    log(sym.info, `Missing packages: ${missing.join(', ')}`);

    const s = spinner('Installing Python dependencies (this may take a few minutes)...');
    const installed = await installSidecarDeps(sidecarDir);
    if (!installed) {
      s.stop(false, 'Failed to install Python dependencies');
      console.log(
        `\n  Try manually: ${c.dim}${venvPythonPath(venvPath, process.platform)} -m pip install -r ${join(sidecarDir, 'requirements.txt')}${c.reset}\n`,
      );
      return;
    }
    s.stop(true, 'Python dependencies installed');
  }

  // Verify sentence-transformers works
  const verifySpinner = spinner('Verifying sentence-transformers...');
  const verified = await verifySidecar(sidecarDir);
  verifySpinner.stop(verified, verified ? 'sentence-transformers OK' : 'sentence-transformers import failed');

  if (!verified) {
    console.log(`\n  ${c.dim}Try: ${python} -c "from sentence_transformers import SentenceTransformer"${c.reset}`);
    console.log(`  ${c.dim}Or use OpenAI embeddings instead: set OPENAI_EMBEDDINGS_ENABLED=true${c.reset}\n`);
    return;
  }

  // Pre-download the embedding model so first real use is fast
  const modelName = getLocalEmbeddingModel();
  await preDownloadModel(sidecarDir, python, modelName);
};

/**
 * Pre-download the embedding model during init so the first parse doesn't hang.
 * SentenceTransformer downloads to ~/.cache/huggingface/ on first load.
 */
const preDownloadModel = async (sidecarDir: string, python: string, modelName: string): Promise<void> => {
  // Check if model is already cached by trying a quick load
  const checkCached = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const proc = spawnProcess(
        python,
        [
          '-c',
          `import transformers.modeling_utils as _mu; hasattr(_mu,'Conv1D') or setattr(_mu,'Conv1D',__import__('transformers.pytorch_utils',fromlist=['Conv1D']).Conv1D); from sentence_transformers import SentenceTransformer; m = SentenceTransformer("${modelName}", trust_remote_code=True); print(f"dims:{len(m.encode(['test'])[0])}")`,
        ],
        { cwd: sidecarDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 },
      );

      let stdout = '';
      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.on('close', (code) => resolve(code === 0 && stdout.includes('dims:')));
      proc.on('error', () => resolve(false));
    });
  };

  // Quick check — if model is cached, this returns in ~5s
  const quickSpinner = spinner(`Checking for cached model (${modelName})...`);
  const isCached = await checkCached();

  if (isCached) {
    quickSpinner.stop(true, `Model ready (${modelName})`);
    return;
  }

  quickSpinner.stop(false, 'Model not cached yet');
  log(sym.info, 'Downloading embedding model (~600MB, only needed once)');

  // Download the model — this can take a few minutes.
  // Pipe stderr directly to the terminal so HuggingFace progress bars render natively.
  const downloaded = await new Promise<boolean>((resolve) => {
    const proc = spawnProcess(
      python,
      [
        '-c',
        `import transformers.modeling_utils as _mu; hasattr(_mu,'Conv1D') or setattr(_mu,'Conv1D',__import__('transformers.pytorch_utils',fromlist=['Conv1D']).Conv1D); from sentence_transformers import SentenceTransformer; print("downloading..."); m = SentenceTransformer("${modelName}", trust_remote_code=True); print(f"done dims:{len(m.encode(['test'])[0])}")`,
      ],
      { cwd: sidecarDir, stdio: ['pipe', 'pipe', 'inherit'] },
    );

    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('close', (code) => {
      resolve(code === 0 && stdout.includes('done'));
    });
    proc.on('error', () => resolve(false));
  });

  if (downloaded) {
    log(sym.ok, 'Embedding model downloaded and cached');
  } else {
    log(sym.warn, 'Model download failed — it will retry on first use');
    console.log(
      `  ${c.dim}You can download manually: ${python} -c "import transformers.modeling_utils as _mu; hasattr(_mu,'Conv1D') or setattr(_mu,'Conv1D',__import__('transformers.pytorch_utils',fromlist=['Conv1D']).Conv1D); from sentence_transformers import SentenceTransformer; SentenceTransformer('${modelName}', trust_remote_code=True)"${c.reset}`,
    );
  }
};

interface InitOptions {
  port?: string;
  httpPort?: string;
  password?: string;
  memory?: string;
  pagecache?: string;
  force?: boolean;
  native?: boolean;
  docker?: boolean;
}

interface ResolvedInitOptions {
  boltPort: number;
  httpPort: number;
  password: string;
  memory: string;
  pagecache: string;
  force: boolean;
}

const DEFAULT_QUERY_LANGUAGE = 'CYPHER_5';

const initConnection = ({ boltPort, password }: ResolvedInitOptions): Neo4jConnection => ({
  uri: `bolt://localhost:${boltPort}`,
  user: NEO4J_CONFIG.defaultUser,
  password,
});

const recordProvider = (provider: Neo4jProviderName, { boltPort, httpPort }: ResolvedInitOptions): void => {
  writeProviderRecord({ provider, boltPort, httpPort });
};

const printNeo4jReady = ({ boltPort, httpPort, password }: ResolvedInitOptions): void => {
  console.log(`
${c.bold}Neo4j is ready${c.reset}

  Browser:     ${c.cyan}http://localhost:${httpPort}${c.reset}
  Bolt URI:    ${c.cyan}bolt://localhost:${boltPort}${c.reset}
  Credentials: ${c.dim}neo4j / ${password}${c.reset}`);
};

/**
 * Init command - set up Neo4j with the native or Docker provider
 */
const runInit = async (options: InitOptions): Promise<void> => {
  const resolved: ResolvedInitOptions = {
    boltPort: options.port ? parseInt(options.port, 10) : NEO4J_CONFIG.boltPort,
    httpPort: options.httpPort ? parseInt(options.httpPort, 10) : NEO4J_CONFIG.httpPort,
    password: options.password ?? NEO4J_CONFIG.defaultPassword,
    memory: options.memory ?? '2G',
    pagecache: options.pagecache ?? '1G',
    force: options.force ?? false,
  };

  header('Code Graph Context Setup');

  const native = createNativeNeo4jProvider();
  let provider: Neo4jProviderName;
  try {
    provider = selectNeo4jProvider({
      native: options.native,
      docker: options.docker,
      platform: process.platform,
      brewAvailable: process.platform === 'darwin' && (await native.isBrewAvailable()),
    });
  } catch (error) {
    log(sym.err, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (provider === 'native') {
    await runNativeInit(native, resolved);
  } else {
    await runDockerInit(resolved);
  }
};

const installNativeNeo4j = async (native: NativeNeo4jProvider): Promise<void> => {
  if (await native.isInstalled()) return;

  const s = spinner('Installing Neo4j with Homebrew (brew install neo4j)...');
  const result = await native.install();
  const installed = result.exitCode === 0 && (await native.isInstalled());
  s.stop(installed, installed ? 'Neo4j installed with Homebrew' : 'brew install neo4j failed');
  if (!installed) {
    console.log(`\n  ${c.dim}${result.stderr.trim().split('\n').slice(-5).join('\n  ')}${c.reset}`);
    console.log(`\n  Run it yourself, then rerun init: ${c.dim}brew install neo4j${c.reset}\n`);
    process.exit(1);
  }
};

const dockerNeo4jUsesPorts = (resolved: ResolvedInitOptions): boolean => {
  if (getContainerStatus() !== 'running') return false;
  const published = getContainerPublishedPorts();
  return published !== null && (published.boltPort === resolved.boltPort || published.httpPort === resolved.httpPort);
};

const queryDefaultLanguage = async (connection: Neo4jConnection): Promise<unknown> => {
  const rows = await queryBolt(
    connection,
    "SHOW SETTINGS YIELD name, value WHERE name = 'db.query.default_language' RETURN value",
  );
  return rows[0]?.value;
};

const runNativeInit = async (native: NativeNeo4jProvider, resolved: ResolvedInitOptions): Promise<void> => {
  const connection = initConnection(resolved);

  await installNativeNeo4j(native);
  log(sym.ok, `Neo4j ${(await native.neo4jVersion()) ?? ''} installed (Homebrew)`);

  if (resolved.force) {
    const s = spinner('Stopping native Neo4j for reconfiguration...');
    await native.stopService();
    s.stop(true, 'Native Neo4j stopped');
  }
  if (resolved.force || !(await native.isConfigured())) {
    await native.configure({
      boltPort: resolved.boltPort,
      httpPort: resolved.httpPort,
      password: resolved.password,
      heapMax: resolved.memory,
      pagecache: resolved.pagecache,
    });
    log(sym.ok, `Config, APOC and launchd agent written under ${c.dim}${native.paths.home}${c.reset}`);
  } else {
    log(sym.ok, 'Native Neo4j already configured');
  }

  if (dockerNeo4jUsesPorts(resolved)) {
    await native.disableService();
    log(sym.warn, `The Docker graph (${NEO4J_CONFIG.containerName}) is still running on these ports`);
    // The embedding setup does not depend on which Neo4j runs, and npm i -g removes it on every upgrade.
    await setupSidecar();
    console.log(
      `\n  Native Neo4j is configured but not started. ${c.dim}code-graph-context migrate-from-docker${c.reset} moves the Docker graph over.\n`,
    );
    return;
  }

  if (await native.isBrewServiceStarted()) {
    log(sym.warn, `brew services runs its own Neo4j; stop it with ${c.dim}brew services stop neo4j${c.reset}`);
  }

  if (resolved.force || !(await probeBolt(connection))) {
    await native.startService();
  }
  const healthSpinner = spinner('Waiting for Neo4j to be ready (this may take a minute)...');
  const ready = await waitForBolt(connection);
  healthSpinner.stop(ready, ready ? 'Neo4j is ready' : 'Neo4j failed to start');
  if (!ready) {
    console.log(`\n  Check logs: ${c.dim}${join(native.paths.logs, 'neo4j.log')}${c.reset}\n`);
    process.exit(1);
  }

  const apocOk = await waitForApoc(connection);
  log(apocOk ? sym.ok : sym.warn, apocOk ? 'APOC plugin verified' : 'APOC plugin not detected');
  const language = await queryDefaultLanguage(connection);
  log(
    language === DEFAULT_QUERY_LANGUAGE ? sym.ok : sym.warn,
    `Default query language: ${String(language)} (expected ${DEFAULT_QUERY_LANGUAGE})`,
  );

  printNeo4jReady(resolved);
  await setupSidecar();
  recordProvider('native', resolved);
  printConfigInstructions(resolved.password, resolved.boltPort);
};

const runDockerInit = async (resolved: ResolvedInitOptions): Promise<void> => {
  const { boltPort, httpPort, password, memory, pagecache, force } = resolved;
  const connection = initConnection(resolved);

  // Check Docker
  if (!isDockerInstalled()) {
    log(sym.err, 'Docker is not installed');
    console.log(`\n  Install Docker: ${c.cyan}https://docs.docker.com/get-docker/${c.reset}\n`);
    process.exit(1);
  }
  log(sym.ok, 'Docker installed');

  if (!isDockerRunning()) {
    log(sym.err, 'Docker daemon is not running');
    console.log(`\n  Start Docker Desktop or run: ${c.dim}sudo systemctl start docker${c.reset}\n`);
    process.exit(1);
  }
  log(sym.ok, 'Docker daemon running');

  // Handle existing container
  const status = getContainerStatus();

  if (status === 'running' && !force) {
    log(sym.ok, 'Neo4j container already running');

    const apocOk = await isApocAvailable(connection);
    log(apocOk ? sym.ok : sym.warn, apocOk ? 'APOC plugin available' : 'APOC plugin not detected');

    console.log(`\n  ${c.dim}Use --force to recreate the container${c.reset}`);

    // Still set up sidecar even if Neo4j is already running
    await setupSidecar();

    recordProvider('docker', resolved);
    printConfigInstructions(password, boltPort);
    return;
  }

  if (status !== 'not-found' && force) {
    const existingImage = getContainerImage();
    const existingVersion = existingImage === null ? null : parseNeo4jVersion(existingImage.split(':')[1] ?? '');
    if (existingVersion !== null && !supportsProjectFilteredSearch(existingVersion)) {
      log(sym.err, `The existing container runs ${existingImage}; its store cannot be opened by ${NEO4J_CONFIG.image}`);
      console.log(
        `\n  A 5.x store must pass through Neo4j 5.26 before 2026.x. Run: ${c.dim}code-graph-context migrate-from-docker${c.reset}\n`,
      );
      process.exit(1);
    }
    const s = spinner('Removing existing container...');
    stopContainer();
    removeContainer();
    s.stop(true, 'Removed existing container');
  }

  if (status === 'stopped' && !force) {
    const s = spinner('Starting existing container...');
    const started = startContainer();
    if (!started) {
      s.stop(false, 'Failed to start container');
      console.log(`\n  Try: ${c.dim}code-graph-context init --force${c.reset}\n`);
      process.exit(1);
    }
    s.stop(true, 'Container started');
  } else if (status === 'not-found' || force) {
    const s = spinner('Creating Neo4j container...');
    const created = createContainer({ httpPort, boltPort, password, memory, pagecache });
    if (!created) {
      s.stop(false, 'Failed to create container');
      console.log(`
  Check if ports are in use:
    ${c.dim}lsof -i :${httpPort}${c.reset}
    ${c.dim}lsof -i :${boltPort}${c.reset}
`);
      process.exit(1);
    }
    s.stop(true, 'Container created');
  }

  // Wait for Neo4j
  const healthSpinner = spinner('Waiting for Neo4j to be ready (this may take a minute)...');
  const ready = await waitForBolt(connection, NEO4J_CONFIG.healthCheckTimeoutMs, NEO4J_CONFIG.healthCheckIntervalMs);
  healthSpinner.stop(ready, ready ? 'Neo4j is ready' : 'Neo4j failed to start');

  if (!ready) {
    console.log(`\n  Check logs: ${c.dim}docker logs ${NEO4J_CONFIG.containerName}${c.reset}\n`);
    process.exit(1);
  }

  // Check APOC
  const apocOk = await waitForApoc(connection);
  log(apocOk ? sym.ok : sym.warn, apocOk ? 'APOC plugin verified' : 'APOC still loading (should be ready shortly)');

  printNeo4jReady(resolved);

  // Set up Python embedding sidecar
  await setupSidecar();

  recordProvider('docker', resolved);
  printConfigInstructions(password, boltPort);
};

const printSidecarStatus = (): void => {
  console.log('');
  const pythonVersion = getPythonVersion();
  log(pythonVersion ? sym.ok : sym.warn, `Python: ${pythonVersion ?? 'not found'}`);

  if (pythonVersion) {
    const venvExists = existsSync(venvPythonPath(resolveSidecarVenvDir(process.env), process.platform));
    log(venvExists ? sym.ok : sym.warn, `Sidecar venv: ${venvExists ? 'exists' : 'not created'}`);

    if (venvExists) {
      const python = getSidecarPython();
      const hasDeps =
        checkPipPackage('sentence_transformers', python) &&
        checkPipPackage('fastapi', python) &&
        checkPipPackage('torch', python);
      log(hasDeps ? sym.ok : sym.warn, `Sidecar deps: ${hasDeps ? 'installed' : 'not installed'}`);
    }
  }

  console.log('');
};

const printNativeStatus = async (native: NativeNeo4jProvider): Promise<void> => {
  const connection = getNeo4jConnection();
  log(sym.ok, 'Provider: native (Homebrew)');

  const installed = await native.isInstalled();
  log(
    installed ? sym.ok : sym.err,
    `Neo4j installed: ${installed ? `yes (${(await native.neo4jVersion()) ?? 'unknown version'})` : 'no'}`,
  );
  if (!installed) {
    console.log(`\n  Install: ${c.dim}brew install neo4j${c.reset}, then ${c.dim}code-graph-context init${c.reset}\n`);
    return;
  }

  const loaded = await native.isServiceLoaded();
  log(loaded ? sym.ok : sym.warn, `Service: ${loaded ? 'loaded' : 'not loaded'}`);
  const ready = await probeBolt(connection);
  log(ready ? sym.ok : sym.warn, `Bolt reachable at ${connection.uri}: ${ready ? 'yes' : 'no'}`);
  if (ready) {
    const apocOk = await isApocAvailable(connection);
    log(apocOk ? sym.ok : sym.warn, `APOC plugin: ${apocOk ? 'available' : 'not available'}`);
  }

  printSidecarStatus();
  if (!ready) {
    console.log(`  Run ${c.dim}code-graph-context init${c.reset} to start Neo4j\n`);
  }
};

const printDockerStatus = async (): Promise<void> => {
  log(sym.ok, 'Provider: docker');
  const status = await getFullStatus();

  log(status.dockerInstalled ? sym.ok : sym.err, `Docker installed: ${status.dockerInstalled ? 'yes' : 'no'}`);

  if (!status.dockerInstalled) {
    console.log(`\n  Install: ${c.cyan}https://docs.docker.com/get-docker/${c.reset}\n`);
    return;
  }

  log(status.dockerRunning ? sym.ok : sym.err, `Docker running: ${status.dockerRunning ? 'yes' : 'no'}`);

  if (!status.dockerRunning) {
    console.log(`\n  Start Docker Desktop or: ${c.dim}sudo systemctl start docker${c.reset}\n`);
    return;
  }

  const containerIcon =
    status.containerStatus === 'running' ? sym.ok : status.containerStatus === 'stopped' ? sym.warn : sym.err;
  log(containerIcon, `Container: ${status.containerStatus}`);

  if (status.containerStatus === 'running') {
    log(status.neo4jReady ? sym.ok : sym.warn, `Neo4j responding: ${status.neo4jReady ? 'yes' : 'no'}`);
    log(
      status.apocAvailable ? sym.ok : sym.warn,
      `APOC plugin: ${status.apocAvailable ? 'available' : 'not available'}`,
    );
  }

  printSidecarStatus();

  if (status.containerStatus !== 'running') {
    console.log(`  Run ${c.dim}code-graph-context init${c.reset} to start Neo4j\n`);
  } else if (!status.apocAvailable) {
    console.log(`  APOC may still be loading. Wait a moment and check again.\n`);
  }
};

/**
 * Status command
 */
const runStatus = async (): Promise<void> => {
  header('Code Graph Context Status');

  if (readProviderRecord()?.provider === 'native') {
    await printNativeStatus(createNativeNeo4jProvider());
  } else {
    await printDockerStatus();
  }
};

/**
 * Stop command
 */
const runStop = async (): Promise<void> => {
  if (readProviderRecord()?.provider === 'native') {
    const native = createNativeNeo4jProvider();
    if (!(await native.isServiceLoaded())) {
      log(sym.info, 'Native Neo4j already stopped');
      return;
    }
    const s = spinner('Stopping Neo4j...');
    try {
      await native.stopService();
      s.stop(true, 'Neo4j stopped');
    } catch (error) {
      s.stop(false, error instanceof Error ? error.message : 'Failed to stop Neo4j');
    }
    return;
  }

  const status = getContainerStatus();

  if (status === 'not-found') {
    log(sym.info, 'No Neo4j container found');
    return;
  }

  if (status === 'stopped') {
    log(sym.info, 'Container already stopped');
    return;
  }

  const s = spinner('Stopping Neo4j...');
  const stopped = stopContainer();
  s.stop(stopped, stopped ? 'Neo4j stopped' : 'Failed to stop container');
};

/**
 * Start MCP server
 */
const startMcpServer = async (): Promise<void> => {
  // The MCP server is in a sibling directory after build
  // cli/cli.js -> mcp/mcp.server.js
  const mcpPath = join(__dirname, '..', 'mcp', 'mcp.server.js');
  // Windows: the ESM loader rejects raw drive-letter paths (C:\...) with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — must be a file:// URL. pathToFileURL()
  // is a no-op passthrough to a valid file:// URL on POSIX paths.
  await import(pathToFileURL(mcpPath).href);
};

// Build CLI
const program = new Command();

program
  .name('code-graph-context')
  .description('MCP server for code graph analysis with Neo4j')
  .version(readPackageVersion());

program
  .command('init')
  .description('Set up Neo4j (native on macOS with Homebrew, otherwise Docker) and show configuration steps')
  .option('-p, --port <port>', 'Neo4j Bolt port', '7687')
  .option('--http-port <port>', 'Neo4j Browser port', '7474')
  .option('--password <password>', 'Neo4j password', 'PASSWORD')
  .option('-m, --memory <size>', 'Max heap memory (e.g., 2G, 4G)', '2G')
  .option('--pagecache <size>', 'Page cache size (e.g., 1G, 2G)', '1G')
  .option('-f, --force', 'Recreate the container, or regenerate native config and restart (data is kept)')
  .option('--native', 'Run Neo4j from Homebrew under launchd (default on macOS with Homebrew)')
  .option('--docker', 'Run Neo4j in a Docker container')
  .action(runInit);

program.command('status').description('Check Neo4j and sidecar status').action(runStatus);

program.command('stop').description('Stop Neo4j').action(runStop);

const embeddings = program.command('embeddings').description('Manage the local embedding server');

embeddings
  .command('start')
  .description('Start the local embedding server detached, or confirm it is already healthy')
  .action(async () => {
    process.exit(await runEmbeddingsStart());
  });

program
  .command('migrate-from-docker')
  .description(
    'Move the Docker Neo4j graph into the native Neo4j, keeping nodes, relationships, properties and indexes',
  )
  .option('--container <name>', 'Docker container holding the graph', NEO4J_CONFIG.containerName)
  .option('--from-dump <dir>', 'Use an existing 5.26 or newer dump directory instead of dumping the container')
  .option('--overwrite', 'Replace data already in the native Neo4j')
  .option('--rollback', 'Stop the native Neo4j and start the Docker container again')
  .action(async (options: MigrateFromDockerOptions) => {
    process.exit(
      await runMigrateFromDocker(options, {
        ...(await createMigrationEnvironment()),
        commands: new ProcessCommandRunner(),
        bolt: new Neo4jBoltClient(),
        files: new NodeMigrationFileSystem(),
        clock: new SystemClock(),
        output: (line) => console.log(line),
        dataDirectory: resolveDataDirectory(process.env),
      }),
    );
  });

const project = program.command('project').description('Manage registered projects');

project
  .command('delete <project>')
  .description('Delete a project (id, name or path) and its graph data; its memory must be moved or deleted explicitly')
  .option('--move-memory-to <project>', 'Move its notes, chunks and bookmarks to this project or collection')
  .option('--delete-memory', 'Delete its notes, chunks and bookmarks with the project')
  .option('--dry-run', 'Print what would move and what would be deleted, and write nothing')
  .option('-y, --yes', 'Do not ask for confirmation')
  .action(async (projectInput: string, options: ProjectDeleteOptions) => {
    const neo4j = new Neo4jService();
    try {
      process.exitCode = await runProjectDelete(projectInput, options, {
        deletion: new ProjectDeletionService(new ProjectService(neo4j), neo4j),
        confirm: confirmOnTerminal,
        writeStdout: (line) => console.log(line),
        writeStderr: (line) => console.error(line),
      });
    } finally {
      await neo4j.close();
    }
  });

// Default action: start MCP server if no command given
const knownCommands = ['init', 'status', 'stop', 'embeddings', 'migrate-from-docker', 'project', 'help'];
const args = process.argv.slice(2);
const hasCommand = args.some((arg) => knownCommands.includes(arg) || arg.startsWith('-'));

if (args.length === 0 || !hasCommand) {
  startMcpServer().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
} else {
  program.parse();
}
