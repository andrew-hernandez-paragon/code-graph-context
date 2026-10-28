/**
 * Neo4j Docker Management
 *
 * Handles Docker container lifecycle for Neo4j
 */

import { execSync } from 'child_process';

import { getNeo4jConnection } from '../storage/neo4j/neo4j-connection.js';

import { isApocAvailable, probeBolt, waitForBolt } from './neo4j-bolt.js';

// Container configuration
export const NEO4J_CONFIG = {
  containerName: 'code-graph-neo4j',
  image: 'neo4j:2026.02.2-community',
  httpPort: 7474,
  boltPort: 7687,
  defaultPassword: 'PASSWORD',
  defaultUser: 'neo4j',
  healthCheckTimeoutMs: 120000,
  healthCheckIntervalMs: 2000,
};

export type ContainerStatus = 'running' | 'stopped' | 'not-found';

export interface CreateContainerOptions {
  containerName?: string;
  httpPort?: number;
  boltPort?: number;
  password?: string;
  memory?: string;
  pagecache?: string;
}

export interface EnsureNeo4jResult {
  success: boolean;
  action: 'already-running' | 'started' | 'created' | 'failed';
  error?: string;
}

export interface FullStatus {
  dockerInstalled: boolean;
  dockerRunning: boolean;
  containerStatus: ContainerStatus;
  neo4jReady: boolean;
  apocAvailable: boolean;
}

/**
 * Execute a command and return stdout, or null if failed
 */
const exec = (command: string): string | null => {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Check if Docker CLI is available
 */
export const isDockerInstalled = (): boolean => exec('docker --version') !== null;

/**
 * Check if Docker daemon is running
 */
export const isDockerRunning = (): boolean => exec('docker info') !== null;

/**
 * Get container status
 */
export const getContainerStatus = (containerName: string = NEO4J_CONFIG.containerName): ContainerStatus => {
  // No quotes around --format: single quotes aren't string delimiters in cmd.exe,
  // so they'd be passed through literally on Windows. The value has no spaces,
  // so it's unambiguous unquoted on every shell. 2>/dev/null is also dropped —
  // exec() already captures stderr via stdio: 'pipe', and /dev/null isn't a
  // null device on Windows.
  const result = exec(`docker inspect --format={{.State.Running}} ${containerName}`);
  if (result === null) return 'not-found';
  return result === 'true' ? 'running' : 'stopped';
};

/**
 * Image an existing container was created from, or null when it does not exist
 */
export const getContainerImage = (containerName: string = NEO4J_CONFIG.containerName): string | null =>
  exec(`docker inspect --format={{.Config.Image}} ${containerName}`);

/**
 * Start an existing stopped container
 */
export const startContainer = (containerName: string = NEO4J_CONFIG.containerName): boolean =>
  exec(`docker start ${containerName}`) !== null;

/**
 * Stop a running container
 */
export const stopContainer = (containerName: string = NEO4J_CONFIG.containerName): boolean =>
  exec(`docker stop ${containerName}`) !== null;

/**
 * Remove a container
 */
export const removeContainer = (containerName: string = NEO4J_CONFIG.containerName): boolean =>
  exec(`docker rm ${containerName}`) !== null;

/**
 * Create and start a new Neo4j container
 */
export const createContainer = (options: CreateContainerOptions = {}): boolean => {
  const {
    containerName = NEO4J_CONFIG.containerName,
    httpPort = NEO4J_CONFIG.httpPort,
    boltPort = NEO4J_CONFIG.boltPort,
    password = NEO4J_CONFIG.defaultPassword,
    memory = '2G',
    pagecache = '1G',
  } = options;

  const cmd = [
    'docker run -d',
    `--name ${containerName}`,
    `--restart unless-stopped`,
    `-p ${httpPort}:7474`,
    `-p ${boltPort}:7687`,
    `-v code-graph-neo4j-data:/data`,
    `-v code-graph-neo4j-logs:/logs`,
    `-e NEO4J_AUTH=neo4j/${password}`,
    `-e 'NEO4J_PLUGINS=["apoc"]'`,
    `-e NEO4J_dbms_security_procedures_unrestricted=apoc.*`,
    `-e NEO4J_server_memory_heap_initial__size=1G`,
    `-e NEO4J_server_memory_heap_max__size=${memory}`,
    `-e NEO4J_server_memory_pagecache_size=${pagecache}`,
    // A local code graph is rebuilt by reparsing, so keep only the logs crash recovery needs.
    `-e NEO4J_db_tx__log_rotation_retention__policy=keep_none`,
    `-e NEO4J_db_tx__log_rotation_size=64M`,
    `-e NEO4J_db_tx__log_preallocate=false`,
    NEO4J_CONFIG.image,
  ].join(' ');

  return exec(cmd) !== null;
};

/**
 * Ensure Neo4j is running - start if needed
 */
export const ensureNeo4jRunning = async (options: CreateContainerOptions = {}): Promise<EnsureNeo4jResult> => {
  const containerName = options.containerName ?? NEO4J_CONFIG.containerName;
  const connection = {
    uri: `bolt://localhost:${options.boltPort ?? NEO4J_CONFIG.boltPort}`,
    user: NEO4J_CONFIG.defaultUser,
    password: options.password ?? NEO4J_CONFIG.defaultPassword,
  };
  const status = getContainerStatus(containerName);

  if (status === 'running') {
    return { success: true, action: 'already-running' };
  }

  if (!isDockerInstalled()) {
    return { success: false, action: 'failed', error: 'Docker not installed' };
  }

  if (!isDockerRunning()) {
    return { success: false, action: 'failed', error: 'Docker daemon not running' };
  }

  // Start existing container
  if (status === 'stopped') {
    if (startContainer(containerName)) {
      const ready = await waitForBolt(
        connection,
        NEO4J_CONFIG.healthCheckTimeoutMs,
        NEO4J_CONFIG.healthCheckIntervalMs,
      );
      return ready
        ? { success: true, action: 'started' }
        : { success: false, action: 'failed', error: 'Container started but Neo4j not responding' };
    }
    return { success: false, action: 'failed', error: 'Failed to start existing container' };
  }

  // Create new container
  if (createContainer(options)) {
    const ready = await waitForBolt(connection, NEO4J_CONFIG.healthCheckTimeoutMs, NEO4J_CONFIG.healthCheckIntervalMs);
    return ready
      ? { success: true, action: 'created' }
      : { success: false, action: 'failed', error: 'Container created but Neo4j not responding' };
  }

  return { success: false, action: 'failed', error: 'Failed to create container' };
};

const CONTAINER_BOLT_PORT = 7687;
const CONTAINER_HTTP_PORT = 7474;

/**
 * Parse `docker port` output such as "7687/tcp -> 0.0.0.0:7687" into the host ports
 */
export const parsePublishedPorts = (output: string): { boltPort: number; httpPort: number } | null => {
  const hostPorts = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+)\/tcp -> \S+:(\d+)$/.exec(line.trim());
    if (match) hostPorts.set(Number(match[1]), Number(match[2]));
  }
  const boltPort = hostPorts.get(CONTAINER_BOLT_PORT);
  const httpPort = hostPorts.get(CONTAINER_HTTP_PORT);
  return boltPort !== undefined && httpPort !== undefined ? { boltPort, httpPort } : null;
};

/**
 * Host ports a container publishes for Bolt and HTTP, or null when it publishes neither
 */
export const getContainerPublishedPorts = (
  containerName: string = NEO4J_CONFIG.containerName,
): { boltPort: number; httpPort: number } | null => {
  const result = exec(`docker port ${containerName}`);
  return result === null ? null : parsePublishedPorts(result);
};

/**
 * Get full status for diagnostics
 */
export const getFullStatus = async (): Promise<FullStatus> => {
  const dockerInstalled = isDockerInstalled();
  const dockerRunning = dockerInstalled && isDockerRunning();
  const containerStatus = dockerRunning ? getContainerStatus() : 'not-found';
  const connection = getNeo4jConnection();
  const neo4jReady = containerStatus === 'running' && (await probeBolt(connection));
  const apocAvailable = neo4jReady && (await isApocAvailable(connection));

  return {
    dockerInstalled,
    dockerRunning,
    containerStatus,
    neo4jReady,
    apocAvailable,
  };
};
