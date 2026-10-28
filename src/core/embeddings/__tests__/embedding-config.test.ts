import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNoteRecallFloor } from '../embedding-config.js';

describe('getNoteRecallFloor', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', 'false');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the calibrated floor for BAAI/bge-base-en-v1.5', () => {
    vi.stubEnv('EMBEDDING_MODEL', 'BAAI/bge-base-en-v1.5');
    expect(getNoteRecallFloor()).toBe(0.8);
  });

  it('returns the calibrated floor for the default local model', () => {
    vi.stubEnv('EMBEDDING_MODEL', '');
    expect(getNoteRecallFloor()).toBe(0.8);
  });

  it('returns 0.3 for a model with no calibration', () => {
    vi.stubEnv('EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2');
    expect(getNoteRecallFloor()).toBe(0.3);
  });
});
