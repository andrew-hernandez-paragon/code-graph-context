import crypto from 'crypto';
import { resolve } from 'path';

import { InvalidProjectInputError } from './project-errors.js';

const PROJECT_ID_PREFIX = 'proj_';
const PROJECT_ID_PATTERN = /^proj_[a-z0-9_-]{1,40}$/;
const PATH_HASH_PATTERN = /^[a-f0-9]{12}$/;
const MAX_COLLECTION_SLUG_LENGTH = 40;

/**
 * Id of a codebase or directory at its creation: `proj_` plus 12 hex characters of sha256(absolute path).
 * An id is minted once; afterwards a project is found by id, name or path, never by hashing again.
 */
export const generateProjectId = (projectPath: string): string => {
  const hash = crypto.createHash('sha256').update(resolve(projectPath)).digest('hex').substring(0, 12);
  return `${PROJECT_ID_PREFIX}${hash}`;
};

export const validateProjectId = (projectId: string): boolean =>
  typeof projectId === 'string' && PROJECT_ID_PATTERN.test(projectId);

/** `setup_hyphae` gives `proj_setup_hyphae`. */
export const collectionProjectId = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .substring(0, MAX_COLLECTION_SLUG_LENGTH)
    .replace(/[-_]+$/g, '');

  if (slug.length === 0) {
    throw new InvalidProjectInputError(
      `Collection name '${name}' has no letters or digits to build an id from. Pass a name such as 'on-call' or 'setup_hyphae'.`,
    );
  }
  if (PATH_HASH_PATTERN.test(slug)) {
    throw new InvalidProjectInputError(
      `Collection name '${name}' becomes '${slug}', which looks like the hash of a directory path. Add a word, for example '${slug}-notes'.`,
    );
  }
  return `${PROJECT_ID_PREFIX}${slug}`;
};

/** The project id inside a code node id: `proj_x:Kind:hash` gives `proj_x`. */
export const projectIdOfNodeId = (nodeId: string): string | null => {
  const projectId = nodeId.split(':')[0];
  return validateProjectId(projectId) ? projectId : null;
};
