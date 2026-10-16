import { Neo4jProviderName } from './neo4j-provider-record.js';

export interface ProviderSelectionInput {
  native?: boolean;
  docker?: boolean;
  platform: NodeJS.Platform;
  brewAvailable: boolean;
}

/** Native on macOS with Homebrew, Docker everywhere else; an explicit flag wins. */
export const selectNeo4jProvider = ({
  native,
  docker,
  platform,
  brewAvailable,
}: ProviderSelectionInput): Neo4jProviderName => {
  if (native && docker) throw new Error('Choose either --native or --docker, not both');
  if (native) return 'native';
  if (docker) return 'docker';
  return platform === 'darwin' && brewAvailable ? 'native' : 'docker';
};
