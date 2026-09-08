/**
 * OpenAI Embeddings Service
 * Uses OpenAI's text-embedding API. Requires OPENAI_API_KEY.
 * Opt-in via OPENAI_EMBEDDINGS_ENABLED=true.
 */

import OpenAI from 'openai';

import { debugLog } from '../../mcp/utils.js';
import { getTimeoutConfig } from '../config/timeouts.js';

export class OpenAIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIConfigError';
  }
}

export class OpenAIAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'OpenAIAPIError';
  }
}

const BATCH_CONFIG = {
  maxBatchSize: 100,
  delayBetweenBatchesMs: 500,
} as const;

export class OpenAIEmbeddingsService {
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(model: string = 'text-embedding-3-large') {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new OpenAIConfigError(
        'OPENAI_API_KEY environment variable is required.\n\n' +
          'OpenAI embeddings require an API key. Local semantic search does not.\n\n' +
          'Set it in your environment:\n' +
          '  export OPENAI_API_KEY=sk-...\n\n' +
          'Or in .env file:\n' +
          '  OPENAI_API_KEY=sk-...\n\n' +
          'Alternative: Use local embeddings (default) which require no API key.',
      );
    }
    const timeoutConfig = getTimeoutConfig();
    this.openai = new OpenAI({
      apiKey,
      timeout: timeoutConfig.openai.embeddingTimeoutMs,
      maxRetries: 2,
    });
    this.model = model;
  }

  async embedText(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: text,
      });
      return response.data[0].embedding;
    } catch (error: any) {
      throw this.wrapError(error);
    }
  }

  async embedTexts(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (error: any) {
      throw this.wrapError(error);
    }
  }

  async embedTextsInBatches(
    texts: string[],
    batchSize: number = BATCH_CONFIG.maxBatchSize,
  ): Promise<(number[] | null)[]> {
    await debugLog('Batch embedding started', { provider: 'openai', textCount: texts.length });

    const results: (number[] | null)[] = [];
    const totalBatches = Math.ceil(texts.length / batchSize);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize) + 1;
      await debugLog('Embedding batch progress', {
        provider: 'openai',
        batchIndex,
        totalBatches,
        batchSize: batch.length,
      });

      const batchResults = await this.embedTexts(batch);
      results.push(...batchResults);

      if (i + batchSize < texts.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_CONFIG.delayBetweenBatchesMs));
      }
    }

    return results;
  }

  private wrapError(error: any): Error {
    if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      return new OpenAIAPIError('OpenAI embedding request timed out. Consider increasing OPENAI_EMBEDDING_TIMEOUT_MS.');
    }
    if (error.status === 429) {
      return new OpenAIAPIError(
        'OpenAI rate limit exceeded. Wait a few minutes and try again.\n' +
          'Check your usage at https://platform.openai.com/usage',
        429,
      );
    }
    if (error.status === 401) {
      return new OpenAIAPIError('OpenAI API key is invalid or expired.\nPlease check your OPENAI_API_KEY.', 401);
    }
    if (error.status === 402 || error.message?.includes('quota') || error.message?.includes('billing')) {
      return new OpenAIAPIError(
        'OpenAI quota exceeded or billing issue.\n' +
          'Check billing at https://platform.openai.com/settings/organization/billing',
        402,
      );
    }
    return new OpenAIAPIError(`OpenAI embedding failed: ${error.message}`, error.status);
  }
}
