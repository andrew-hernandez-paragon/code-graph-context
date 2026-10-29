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

export const UNCALIBRATED_RECALL_FLOOR = 0.3;

// Note-recall floors on the tool similarity scale, (1 + cosine) / 2. Calibration: docs/code-graph-context/research/recall-relevance-calibration.md
export const NOTE_RECALL_FLOORS: Record<string, number> = {
  'BAAI/bge-base-en-v1.5': 0.8,
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

export const getNoteRecallFloor = (): number => NOTE_RECALL_FLOORS[getEmbeddingModel()] ?? UNCALIBRATED_RECALL_FLOOR;

export const DEFAULT_RERANK_MODEL = 'BAAI/bge-reranker-base';

// Reranker score floors for note recall; scores are probabilities from 0 to 1. Calibration:
// docs/code-graph-context/research/recall-v2.md. An uncalibrated model keeps every reranked note.
export const NOTE_RERANK_FLOORS: Record<string, number> = {
  'BAAI/bge-reranker-base': 0.02,
};

export const getRerankModel = (): string => process.env.RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL;

/** The reranker runs in the local sidecar, so it is off with OpenAI embeddings and when RERANK_MODEL disables it. */
export const isRerankEnabled = (): boolean =>
  !isOpenAIEnabled() && !['none', 'off', 'false', '0'].includes(getRerankModel().toLowerCase());

export const getNoteRerankFloor = (): number => NOTE_RERANK_FLOORS[getRerankModel()] ?? 0;
