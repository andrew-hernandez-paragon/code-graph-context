import { homedir } from 'os';
import { join } from 'path';

/** CGC_DATA_DIR overrides the directory that holds Neo4j data and the sidecar virtualenv. */
export const resolveDataDirectory = (env: NodeJS.ProcessEnv): string =>
  env.CGC_DATA_DIR ?? join(homedir(), '.local', 'share', 'code-graph-context');
