import { describe, expect, it } from 'vitest';

import { resolveDataDirectory } from '../data-directory.js';

describe('resolveDataDirectory', () => {
  it('honours CGC_DATA_DIR', () => {
    expect(resolveDataDirectory({ CGC_DATA_DIR: '/data/cgc' })).toBe('/data/cgc');
  });

  it('defaults to ~/.local/share/code-graph-context', () => {
    expect(resolveDataDirectory({})).toMatch(/\/\.local\/share\/code-graph-context$/);
  });
});
