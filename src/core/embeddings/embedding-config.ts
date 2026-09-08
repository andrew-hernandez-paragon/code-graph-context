export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'BAAI/bge-base-en-v1.5';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large';

export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
  'codesage/codesage-base-v2': 1024,
  'Qodo/Qodo-Embed-1-1.5B': 1536,
  'sentence-transformers/all-MiniLM-L6-v2': 384,
  'sentence-transformers/all-mpnet-base-v2': 768,
  'BAAI/bge-small-en-v1.5': 384,
  'BAAI/bge-base-en-v1.5': 768,
  'nomic-ai/nomic-embed-text-v1.5': 768,
};

export const isOpenAIAvailable = (): boolean => Boolean(process.env.OPENAI_API_KEY?.trim());

export const isOpenAIRequested = (): boolean => {
  // An explicit new flag overrides the deprecated alias, including false.
  const enabled = process.env.OPENAI_EMBEDDINGS_ENABLED ?? process.env.OPENAI_ENABLED;
  return enabled?.trim().toLowerCase() === 'true';
};

export const isOpenAIEnabled = (): boolean => isOpenAIRequested() && isOpenAIAvailable();

export const getLocalEmbeddingModel = (): string =>
  process.env.EMBEDDING_MODEL?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;

export const getEmbeddingModel = (): string =>
  isOpenAIEnabled()
    ? process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL
    : getLocalEmbeddingModel();

export const getEmbeddingDimensions = (): number =>
  EMBEDDING_DIMENSIONS[getEmbeddingModel()] ?? (isOpenAIEnabled() ? 3072 : 1536);
