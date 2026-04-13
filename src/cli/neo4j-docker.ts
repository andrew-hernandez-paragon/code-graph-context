/**
 * Neo4j Docker Management
 *
 * Handles Docker container lifecycle for Neo4j
 */

import { execSync } from 'child_process';

// Container configuration
export const NEO4J_CONFIG = {
  containerName: 'code-graph-neo4j',
  image: 'neo4j:5.23',
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
  const result = exec(`docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null`);
  if (result === null) return 'not-found';
  return result === 'true' ? 'running' : 'stopped';
};

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
    NEO4J_CONFIG.image,
  ].join(' ');

  return exec(cmd) !== null;
};

/**
 * Check if Neo4j is accepting connections
 */
export const isNeo4jReady = (
  containerName: string = NEO4J_CONFIG.containerName,
  password: string = NEO4J_CONFIG.defaultPassword,
): boolean => {
  const result = exec(`docker exec ${containerName} cypher-shell -u neo4j -p ${password} "RETURN 1" 2>/dev/null`);
  return result !== null;
};

/**
 * Check if APOC plugin is available
 */
export const isApocAvailable = (
  containerName = NEO4J_CONFIG.containerName,
  password = NEO4J_CONFIG.defaultPassword,
): boolean => {
  const result = exec(
    `docker exec ${containerName} cypher-shell -u neo4j -p ${password} "CALL apoc.help('apoc') YIELD name RETURN count(name)" 2>/dev/null`,
  );
  return result !== null && !result.includes('error');
};

/**
 * Wait for Neo4j to be ready
 */
export const waitForNeo4j = async (
  containerName: string = NEO4J_CONFIG.containerName,
  password: string = NEO4J_CONFIG.defaultPassword,
  timeoutMs: number = NEO4J_CONFIG.healthCheckTimeoutMs,
): Promise<boolean> => {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (isNeo4jReady(containerName, password)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, NEO4J_CONFIG.healthCheckIntervalMs));
  }

  return false;
};

/**
 * Ensure Neo4j is running - start if needed
 */
export const ensureNeo4jRunning = async (options: CreateContainerOptions = {}): Promise<EnsureNeo4jResult> => {
  const containerName = options.containerName ?? NEO4J_CONFIG.containerName;
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
      const ready = await waitForNeo4j(containerName, options.password);
      return ready
        ? { success: true, action: 'started' }
        : { success: false, action: 'failed', error: 'Container started but Neo4j not responding' };
    }
    return { success: false, action: 'failed', error: 'Failed to start existing container' };
  }

  // Create new container
  if (createContainer(options)) {
    const ready = await waitForNeo4j(containerName, options.password);
    return ready
      ? { success: true, action: 'created' }
      : { success: false, action: 'failed', error: 'Container created but Neo4j not responding' };
  }

  return { success: false, action: 'failed', error: 'Failed to create container' };
};

/**
 * Get full status for diagnostics
 */
export const getFullStatus = (): FullStatus => {
  const dockerInstalled = isDockerInstalled();
  const dockerRunning = dockerInstalled && isDockerRunning();
  const containerStatus = dockerRunning ? getContainerStatus() : 'not-found';
  const neo4jReady = containerStatus === 'running' && isNeo4jReady();
  const apocAvailable = neo4jReady && isApocAvailable();

  return {
    dockerInstalled,
    dockerRunning,
    containerStatus,
    neo4jReady,
    apocAvailable,
  };
};
