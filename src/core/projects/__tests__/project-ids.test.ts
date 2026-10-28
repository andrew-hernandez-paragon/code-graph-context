import { describe, expect, it } from 'vitest';

import { InvalidProjectInputError } from '../project-errors.js';
import { collectionProjectId, generateProjectId, projectIdOfNodeId, validateProjectId } from '../project-ids.js';
import { projectKindCypher } from '../project-kinds.js';

describe('generateProjectId', () => {
  it('hashes the absolute path into proj_ plus 12 hex characters', () => {
    expect(generateProjectId('/work/agent-os')).toBe('proj_3d1e86f8f5ad');
  });

  it('gives a relative and an absolute spelling of one path the same id', () => {
    expect(generateProjectId('/work/repo/../agent-os/')).toBe(generateProjectId('/work/agent-os'));
  });
});

describe('collectionProjectId', () => {
  it('turns setup_hyphae into proj_setup_hyphae', () => {
    expect(collectionProjectId('setup_hyphae')).toBe('proj_setup_hyphae');
  });

  it('lowercases and replaces each run of other characters with one hyphen', () => {
    expect(collectionProjectId('On Call  /  Runbooks')).toBe('proj_on-call-runbooks');
  });

  it('trims hyphens and underscores from both ends', () => {
    expect(collectionProjectId('--_on-call_--')).toBe('proj_on-call');
  });

  it('cuts the slug at 40 characters', () => {
    expect(collectionProjectId('a'.repeat(60))).toBe(`proj_${'a'.repeat(40)}`);
  });

  it('rejects a name with nothing left after slugging', () => {
    expect(() => collectionProjectId('***')).toThrow(InvalidProjectInputError);
  });

  it('rejects a slug of exactly 12 hex characters because it would look like a path hash', () => {
    expect(() => collectionProjectId('a1b2c3d4e5f6')).toThrow(/looks like the hash of a directory path/);
  });

  it('accepts 12 characters that are not all hex, and 13 hex characters', () => {
    expect(collectionProjectId('a1b2c3d4e5fz')).toBe('proj_a1b2c3d4e5fz');
    expect(collectionProjectId('a1b2c3d4e5f60')).toBe('proj_a1b2c3d4e5f60');
  });
});

describe('validateProjectId', () => {
  it.each([
    ['proj_a1b2c3d4e5f6', true],
    ['proj_setup_hyphae', true],
    ['proj_', false],
    ['setup_hyphae', false],
    ['proj_Upper', false],
    [`proj_${'a'.repeat(41)}`, false],
  ])('%s -> %s', (projectId, expected) => {
    expect(validateProjectId(projectId)).toBe(expected);
  });
});

describe('projectIdOfNodeId', () => {
  it('reads the project id prefix of a code node id', () => {
    expect(projectIdOfNodeId('proj_x:ClassDeclaration:abc123')).toBe('proj_x');
  });

  it('returns null when the prefix is not a project id', () => {
    expect(projectIdOfNodeId('note_123')).toBeNull();
  });
});

describe('projectKindCypher', () => {
  it('keeps a stored kind and otherwise derives it from the parse status, then the path', () => {
    expect(projectKindCypher('p').replace(/\s+/g, ' ')).toBe(
      "coalesce(p.kind, CASE WHEN p.status IN ['parsing', 'complete', 'failed'] THEN 'codebase' WHEN p.path IS NOT NULL THEN 'directory' ELSE 'collection' END)",
    );
  });
});
