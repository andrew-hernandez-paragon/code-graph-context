/**
 * Timeout Configuration
 * Centralized timeout settings for external services (Neo4j, OpenAI)
 */

export const TIMEOUT_DEFAULTS = {
  neo4j: {
    queryTimeoutMs: 300_000, // 5 minutes — large monorepo edge imports need headroom
    connectionTimeoutMs: 10_000, // 10 seconds
  },
  openai: {
    embeddingTimeoutMs: 60_000, // 60 seconds
    assistantTimeoutMs: 120_000, // 2 minutes (assistant/threads can take longer)
  },
} as const;

export interface TimeoutConfig {
  neo4j: {
    queryTimeoutMs: number;
    connectionTimeoutMs: number;
  };
  openai: {
    embeddingTimeoutMs: number;
    assistantTimeoutMs: number;
  };
}

/**
 * Get timeout configuration with environment variable overrides
 */
export const getTimeoutConfig = (): TimeoutConfig => ({
  neo4j: {
    queryTimeoutMs: parseInt(process.env.NEO4J_QUERY_TIMEOUT_MS ?? '', 10) || TIMEOUT_DEFAULTS.neo4j.queryTimeoutMs,
    connectionTimeoutMs:
      parseInt(process.env.NEO4J_CONNECTION_TIMEOUT_MS ?? '', 10) || TIMEOUT_DEFAULTS.neo4j.connectionTimeoutMs,
  },
  openai: {
    embeddingTimeoutMs:
      parseInt(process.env.OPENAI_EMBEDDING_TIMEOUT_MS ?? '', 10) || TIMEOUT_DEFAULTS.openai.embeddingTimeoutMs,
    assistantTimeoutMs:
      parseInt(process.env.OPENAI_ASSISTANT_TIMEOUT_MS ?? '', 10) || TIMEOUT_DEFAULTS.openai.assistantTimeoutMs,
  },
});
