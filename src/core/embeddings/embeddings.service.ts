/**
 * Embeddings Service — barrel module
 *
 * Exports a common interface and a factory. Consumers do `new EmbeddingsService()`
 * and get the right implementation based on OPENAI_EMBEDDINGS_ENABLED.
 *
 *   OPENAI_EMBEDDINGS_ENABLED=true  → OpenAI text-embedding-3-large (requires OPENAI_API_KEY)
 *   default                         → Local Python sidecar with BGE-base (768 dimensions)
 */

import { getEmbeddingDimensions, getEmbeddingModel, isOpenAIEnabled } from './embedding-config.js';
import { LocalEmbeddingsService } from './local-embeddings.service.js';
import { OpenAIEmbeddingsService } from './openai-embeddings.service.js';

export {
  EMBEDDING_DIMENSIONS,
  getEmbeddingDimensions,
  getEmbeddingModel,
  isOpenAIAvailable,
  isOpenAIEnabled,
  isOpenAIRequested,
} from './embedding-config.js';

// Re-export error classes so existing imports keep working
export { OpenAIConfigError, OpenAIAPIError } from './openai-embeddings.service.js';

export interface IEmbeddingsService {
  embedText(text: string): Promise<number[]>;
  embedTexts(texts: string[]): Promise<(number[] | null)[]>;
  embedTextsInBatches(texts: string[], batchSize?: number): Promise<(number[] | null)[]>;
}

export const EMBEDDING_BATCH_CONFIG = {
  maxBatchSize: 100,
  delayBetweenBatchesMs: 500,
} as const;

/**
 * Factory that returns the correct service based on OPENAI_EMBEDDINGS_ENABLED.
 * Drop-in replacement everywhere `new EmbeddingsService()` was used.
 */
export class EmbeddingsService implements IEmbeddingsService {
  private readonly impl: IEmbeddingsService;
  readonly provider: 'local' | 'openai';
  readonly model: string;
  readonly dimensions: number;

  constructor(model?: string) {
    this.provider = isOpenAIEnabled() ? 'openai' : 'local';
    this.model = this.provider === 'openai' ? (model ?? getEmbeddingModel()) : getEmbeddingModel();
    this.dimensions = getEmbeddingDimensions();
    if (this.provider === 'openai') {
      this.impl = new OpenAIEmbeddingsService(this.model);
    } else {
      this.impl = new LocalEmbeddingsService();
    }
  }

  embedText(text: string): Promise<number[]> {
    return this.impl.embedText(text);
  }

  embedTexts(texts: string[]): Promise<(number[] | null)[]> {
    return this.impl.embedTexts(texts);
  }

  embedTextsInBatches(texts: string[], batchSize?: number): Promise<(number[] | null)[]> {
    return this.impl.embedTextsInBatches(texts, batchSize);
  }
}
