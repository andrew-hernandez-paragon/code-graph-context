/**
 * Local Embeddings Service
 * Uses a Python sidecar running CodeSage-Base-v2 (or configurable model).
 * Default provider — no API key required.
 */

import { debugLog } from '../../mcp/utils.js';

import { getEmbeddingSidecar } from './embedding-sidecar.js';

const BATCH_CONFIG = {
  maxBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE ?? '', 10) || 16,
} as const;

export class LocalEmbeddingsService {
  async embedText(text: string): Promise<number[]> {
    const sidecar = getEmbeddingSidecar();
    return sidecar.embedText(text);
  }

  async embedTexts(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    const sidecar = getEmbeddingSidecar();
    return sidecar.embed(texts);
  }

  async embedTextsInBatches(
    texts: string[],
    batchSize: number = BATCH_CONFIG.maxBatchSize,
  ): Promise<(number[] | null)[]> {
    // Cap batch size — callers (e.g. graph-generator) may pass 100 which OOMs the local model
    const safeBatchSize = Math.min(batchSize, BATCH_CONFIG.maxBatchSize);
    await debugLog('Batch embedding started', { provider: 'local', textCount: texts.length });

    const sidecar = getEmbeddingSidecar();
    const results: (number[] | null)[] = [];
    const totalBatches = Math.ceil(texts.length / safeBatchSize);

    for (let i = 0; i < texts.length; i += safeBatchSize) {
      const batch = texts.slice(i, i + safeBatchSize);
      const batchIndex = Math.floor(i / batchSize) + 1;
      await debugLog('Embedding batch progress', {
        provider: 'local',
        batchIndex,
        totalBatches,
        batchSize: batch.length,
      });

      const batchResults = await sidecar.embed(batch);
      results.push(...batchResults);
    }

    return results;
  }
}
