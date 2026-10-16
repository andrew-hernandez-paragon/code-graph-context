/**
 * Node implementations of the ports `migrate-from-docker` runs against: Bolt, files and time.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';

import neo4j from 'neo4j-driver';

import { Neo4jConnection } from '../storage/neo4j/neo4j-connection.js';

import { BoltClient, Clock, GraphSnapshot, MigrationFileSystem } from './migrate-from-docker.js';
import { probeBolt } from './neo4j-bolt.js';

export class Neo4jBoltClient implements BoltClient {
  isReachable(endpoint: Neo4jConnection): Promise<boolean> {
    return probeBolt(endpoint);
  }

  async captureGraphSnapshot(endpoint: Neo4jConnection): Promise<GraphSnapshot> {
    const driver = this.openDriver(endpoint);
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const nodes = await session.run('MATCH (n) RETURN count(n) AS count');
      const relationships = await session.run('MATCH ()-[r]->() RETURN count(r) AS count');
      const labels = await session.run('CALL db.labels() YIELD label RETURN label ORDER BY label');
      const labelCounts: Record<string, number> = {};
      for (const record of labels.records) {
        const label: string = record.get('label');
        const counted = await session.run(`MATCH (n:\`${label.replace(/`/g, '``')}\`) RETURN count(n) AS count`);
        labelCounts[label] = counted.records[0].get('count');
      }
      const indexes = await session.run(
        'SHOW INDEXES YIELD name, type, state, populationPercent, labelsOrTypes, properties ' +
          'RETURN name, type, state, populationPercent, labelsOrTypes, properties ORDER BY name',
      );
      return {
        nodeCount: nodes.records[0].get('count'),
        relationshipCount: relationships.records[0].get('count'),
        labelCounts,
        indexes: indexes.records.map((record) => ({
          name: record.get('name'),
          type: record.get('type'),
          state: record.get('state'),
          populationPercent: record.get('populationPercent'),
          labelsOrTypes: record.get('labelsOrTypes') ?? [],
          properties: record.get('properties') ?? [],
        })),
      };
    } finally {
      await session.close();
      await driver.close();
    }
  }

  private openDriver(endpoint: Neo4jConnection) {
    return neo4j.driver(endpoint.uri, neo4j.auth.basic(endpoint.user, endpoint.password), {
      disableLosslessIntegers: true,
    });
  }
}

export class NodeMigrationFileSystem implements MigrationFileSystem {
  async makeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  writeText(path: string, text: string): Promise<void> {
    return writeFile(path, text);
  }

  readText(path: string): Promise<string> {
    return readFile(path, 'utf-8');
  }

  async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async listDirectories(path: string): Promise<string[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  async sizeInBytes(path: string): Promise<number> {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    const children = await readdir(path);
    const sizes = await Promise.all(children.map((child) => this.sizeInBytes(join(path, child))));
    return sizes.reduce((total, size) => total + size, 0);
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
