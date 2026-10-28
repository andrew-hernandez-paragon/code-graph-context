import { describe, expect, it } from 'vitest';

import { AmbiguousProjectError } from '../project-errors.js';
import {
  deepestEnclosingProjects,
  describeProjects,
  preferCodebase,
  type RegisteredProject,
} from '../project-resolution.js';

const project = (projectId: string, kind: RegisteredProject['kind'], path: string): RegisteredProject => ({
  projectId,
  name: projectId,
  kind,
  path,
  description: null,
  status: null,
  nodeCount: null,
  edgeCount: null,
  updatedAt: null,
});

describe('deepestEnclosingProjects', () => {
  const outer = project('proj_outer', 'directory', '/work');
  const inner = project('proj_inner', 'codebase', '/work/repo');
  const twin = project('proj_twin', 'directory', '/work/repo');

  it('returns the projects at the deepest root that contains the location', () => {
    expect(deepestEnclosingProjects([outer, inner, twin], '/work/repo/src').map((p) => p.projectId)).toEqual([
      'proj_inner',
      'proj_twin',
    ]);
  });

  it('is empty when no root contains the location', () => {
    expect(deepestEnclosingProjects([inner], '/elsewhere')).toEqual([]);
  });

  it('does not treat a sibling that shares a name prefix as enclosing', () => {
    expect(deepestEnclosingProjects([inner], '/work/repository')).toEqual([]);
  });
});

describe('preferCodebase', () => {
  it('picks the codebase over a directory at the same path', () => {
    const directory = project('proj_dir', 'directory', '/work/repo');
    const codebase = project('proj_code', 'codebase', '/work/repo');

    expect(preferCodebase([directory, codebase])).toBe(codebase);
  });

  it('rejects two projects of the same kind', () => {
    const first = project('proj_a', 'directory', '/work/repo');
    const second = project('proj_b', 'directory', '/work/repo');

    expect(() => preferCodebase([first, second])).toThrow(AmbiguousProjectError);
  });
});

describe('describeProjects', () => {
  it('says none for an empty registry', () => {
    expect(describeProjects([], 0)).toBe('none');
  });

  it('counts the projects it does not list', () => {
    const listed = Array.from({ length: 10 }, (_, index) => project(`proj_${index}`, 'codebase', `/work/${index}`));

    expect(describeProjects(listed, 13)).toMatch(/; and 3 more$/);
  });
});
