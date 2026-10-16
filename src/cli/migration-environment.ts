/**
 * Supplies the native Neo4j target and the provider record that `migrate-from-docker` runs against.
 */

import { MigrationTarget, ProviderRecord } from './migrate-from-docker.js';

export interface MigrationEnvironment {
  target: MigrationTarget;
  provider: ProviderRecord;
}

export const createMigrationEnvironment = (): MigrationEnvironment => {
  // TODO: construct NativeNeo4j and its provider record once feature/native-neo4j lands.
  throw new Error('The native Neo4j provider is not part of this build');
};
