/**
 * One-shot migration: re-embeds every SessionNote, SessionBookmark, and
 * SessionNoteChunk with the currently-configured embedding model/dimensions.
 *
 * Needed after switching EMBEDDING_MODEL (e.g. codesage-base-v2 [1024-dim] ->
 * bge-base-en-v1.5 [768-dim]) — the old vector indexes must already be
 * dropped (dimensions are fixed at index-creation time), and this script
 * both recreates them at the new dimension and backfills every existing
 * node's embedding so nothing silently falls out of session_recall.
 *
 * Reproduces the exact embedding-text formulas used at write time:
 *   - SessionNote:       `${topic}\n\n${content}`        (session-note/session-save/session-update tools)
 *   - SessionBookmark:   [taskContext, summary, findings, nextSteps]
 *                          .filter(Boolean).join('\n\n')  (session-save tool)
 *   - SessionNoteChunk:  raw chunk `content`               (note-chunker output)
 *
 * Safe to re-run — always re-embeds current content, no append-only state.
 *
 * Usage:
 *   npm run reembed:sessions
 */

import 'dotenv/config';

import { EmbeddingsService, getEmbeddingDimensions } from '../src/core/embeddings/embeddings.service.js';
import { Neo4jService, QUERIES } from '../src/storage/neo4j/neo4j.service.js';

const FIND_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.embedding IS NOT NULL
  RETURN n.id AS id, n.projectId AS projectId, n.topic AS topic, n.content AS content
`;

const FIND_BOOKMARKS_QUERY = `
  MATCH (b:SessionBookmark)
  WHERE b.embedding IS NOT NULL
  RETURN b.id AS id, b.projectId AS projectId, b.taskContext AS taskContext,
         b.summary AS summary, b.findings AS findings, b.nextSteps AS nextSteps
`;

const FIND_CHUNKS_QUERY = `
  MATCH (c:SessionNoteChunk)
  WHERE c.embedding IS NOT NULL
  RETURN c.id AS id, c.projectId AS projectId, c.content AS content
`;

const SET_NOTE_EMBEDDING_QUERY = `
  MATCH (n:SessionNote {id: $id, projectId: $projectId})
  SET n.embedding = $embedding, n.embeddingProvider = $embeddingProvider,
      n.embeddingModel = $embeddingModel, n.embeddingDimensions = size($embedding)
  RETURN n.id AS id
`;

const SET_CHUNK_EMBEDDING_QUERY = `
  MATCH (c:SessionNoteChunk {id: $id, projectId: $projectId})
  SET c.embedding = $embedding, c.embeddingProvider = $embeddingProvider,
      c.embeddingModel = $embeddingModel, c.embeddingDimensions = size($embedding)
  RETURN c.id AS id
`;

interface RowWithId {
  id: string;
  projectId: string;
}

async function reembedRows<T extends RowWithId>(
  label: string,
  rows: T[],
  buildText: (row: T) => string,
  embeddingsService: EmbeddingsService,
  neo4jService: Neo4jService,
  setQuery: string,
): Promise<number> {
  if (rows.length === 0) {
    console.log(`  No ${label} with existing embeddings found. Nothing to do.`);
    return 0;
  }

  console.log(`  Found ${rows.length} ${label}(s). Re-embedding...`);

  const texts = rows.map(buildText);
  const embeddings = await embeddingsService.embedTextsInBatches(texts);

  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) {
      console.warn(`    Skipped ${label} ${rows[i].id} (embedding failed)`);
      continue;
    }
    await neo4jService.run(setQuery, {
      // Different SET_*_EMBEDDING_QUERY variants name their id parameter
      // differently (id / noteId / bookmarkId / chunkId) — pass all aliases,
      // Neo4j ignores unused parameters.
      id: rows[i].id,
      noteId: rows[i].id,
      bookmarkId: rows[i].id,
      chunkId: rows[i].id,
      projectId: rows[i].projectId,
      embedding,
      embeddingProvider: embeddingsService.provider,
      embeddingModel: embeddingsService.model,
    });
    updated++;
  }

  console.log(`  Re-embedded ${updated}/${rows.length} ${label}(s).`);
  return updated;
}

const main = async (): Promise<void> => {
  const neo4jService = new Neo4jService();
  const embeddingsService = new EmbeddingsService();
  const dims = getEmbeddingDimensions();

  try {
    console.log(`Target embedding dimensions: ${dims}`);
    console.log('Recreating session vector indexes at new dimension...');
    await neo4jService.run(QUERIES.CREATE_SESSION_NOTES_VECTOR_INDEX(dims));
    await neo4jService.run(QUERIES.CREATE_SESSION_NOTE_CHUNKS_VECTOR_INDEX(dims));
    await neo4jService.run(QUERIES.CREATE_SESSION_BOOKMARKS_VECTOR_INDEX(dims));
    console.log('Indexes ready.\n');

    console.log('SessionNote:');
    const notes = (await neo4jService.run(FIND_NOTES_QUERY)) as Array<{
      id: string;
      projectId: string;
      topic: string;
      content: string;
    }>;
    await reembedRows(
      'SessionNote',
      notes,
      (n) => `${n.topic}\n\n${n.content}`,
      embeddingsService,
      neo4jService,
      SET_NOTE_EMBEDDING_QUERY,
    );

    console.log('\nSessionBookmark:');
    const bookmarks = (await neo4jService.run(FIND_BOOKMARKS_QUERY)) as Array<{
      id: string;
      projectId: string;
      taskContext: string | null;
      summary: string | null;
      findings: string | null;
      nextSteps: string | null;
    }>;
    await reembedRows(
      'SessionBookmark',
      bookmarks,
      (b) => [b.taskContext, b.summary, b.findings, b.nextSteps].filter((s) => s && s.length > 0).join('\n\n'),
      embeddingsService,
      neo4jService,
      QUERIES.SET_BOOKMARK_EMBEDDING_QUERY,
    );

    console.log('\nSessionNoteChunk:');
    const chunks = (await neo4jService.run(FIND_CHUNKS_QUERY)) as Array<{
      id: string;
      projectId: string;
      content: string;
    }>;
    await reembedRows(
      'SessionNoteChunk',
      chunks,
      (c) => c.content,
      embeddingsService,
      neo4jService,
      SET_CHUNK_EMBEDDING_QUERY,
    );

    console.log('\nDone. Session notes/bookmarks/chunks are now searchable at the new embedding dimension.');
    console.log('Next: reparse each project (clearExisting: true) to regenerate code-node embeddings.');
  } finally {
    await neo4jService.close();
  }
};

main().catch((err) => {
  console.error('Session re-embedding migration failed:', err);
  process.exit(1);
});
