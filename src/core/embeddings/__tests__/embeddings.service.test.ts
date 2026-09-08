import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ local: vi.fn(), openai: vi.fn(), localEmbed: vi.fn(), openaiEmbed: vi.fn() }));
vi.mock('../local-embeddings.service.js', () => ({
  LocalEmbeddingsService: class {
    constructor() {
      mocks.local();
    }
    embedText = mocks.localEmbed;
  },
}));
vi.mock('../openai-embeddings.service.js', () => ({
  OpenAIEmbeddingsService: class {
    constructor(model: string) {
      mocks.openai(model);
    }
    embedText = mocks.openaiEmbed;
  },
  OpenAIConfigError: Error,
  OpenAIAPIError: Error,
}));

import {
  EmbeddingsService,
  getEmbeddingDimensions,
  isOpenAIAvailable,
  isOpenAIEnabled,
} from '../embeddings.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    'OPENAI_EMBEDDINGS_ENABLED',
    'OPENAI_ENABLED',
    'OPENAI_API_KEY',
    'OPENAI_EMBEDDING_MODEL',
    'EMBEDDING_MODEL',
  ]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe('embedding provider selection', () => {
  it.each([
    { flag: undefined, key: undefined, openai: false },
    { flag: undefined, key: 'test-key', openai: false },
    { flag: 'false', key: 'test-key', openai: false },
    { flag: 'true', key: undefined, openai: false },
    { flag: 'true', key: '   ', openai: false },
    { flag: 'true', key: 'test-key', openai: true },
    { flag: ' TRUE ', key: 'test-key', openai: true },
  ])('selects the provider for $flag and key $key', ({ flag, key, openai }) => {
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', flag);
    vi.stubEnv('OPENAI_API_KEY', key);
    const service = new EmbeddingsService();
    expect(isOpenAIEnabled()).toBe(openai);
    expect(service.provider).toBe(openai ? 'openai' : 'local');
    expect(service.model).toBe(openai ? 'text-embedding-3-large' : 'BAAI/bge-base-en-v1.5');
    expect(getEmbeddingDimensions()).toBe(openai ? 3072 : 768);
    expect(mocks.openai).toHaveBeenCalledTimes(openai ? 1 : 0);
    expect(mocks.local).toHaveBeenCalledTimes(openai ? 0 : 1);
  });

  it('lets an explicit false override the deprecated flag', () => {
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', 'false');
    vi.stubEnv('OPENAI_ENABLED', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(new EmbeddingsService().provider).toBe('local');
  });

  it('supports the deprecated explicit opt-in when the new flag is absent', () => {
    vi.stubEnv('OPENAI_ENABLED', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(new EmbeddingsService().provider).toBe('openai');
  });

  it('keeps the key-only language service available with local embeddings', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(isOpenAIAvailable()).toBe(true);
    expect(new EmbeddingsService().provider).toBe('local');
  });

  it('uses the configured OpenAI model for both requests and dimensions', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', 'true');
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');
    const service = new EmbeddingsService();
    expect(mocks.openai).toHaveBeenCalledWith('text-embedding-3-small');
    expect(service.model).toBe('text-embedding-3-small');
    expect(getEmbeddingDimensions()).toBe(1536);
  });

  it('does not switch to OpenAI when local embedding fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    mocks.localEmbed.mockRejectedValueOnce(new Error('local unavailable'));
    await expect(new EmbeddingsService().embedText('code')).rejects.toThrow('local unavailable');
    expect(mocks.openai).not.toHaveBeenCalled();
  });

  it('does not switch to local when OpenAI fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_EMBEDDINGS_ENABLED', 'true');
    mocks.openaiEmbed.mockRejectedValueOnce(new Error('rate limited'));
    await expect(new EmbeddingsService().embedText('code')).rejects.toThrow('rate limited');
    expect(mocks.local).not.toHaveBeenCalled();
  });
});
