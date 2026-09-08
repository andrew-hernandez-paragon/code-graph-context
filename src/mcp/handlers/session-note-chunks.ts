import { EmbeddingsService, getEmbeddingDimensions } from '../../core/embeddings/embeddings.service.js';
import { chunkNoteContent } from '../../core/session/note-chunker.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';

export const saveSessionNoteChunks = async (
  neo4jService: Pick<Neo4jService, 'run'>,
  projectId: string,
  noteId: string,
  content: string,
): Promise<number> => {
  const chunks = chunkNoteContent(content);
  if (chunks.length === 0) return 0;

  await neo4jService.run(QUERIES.CREATE_SESSION_NOTE_CHUNKS_VECTOR_INDEX(getEmbeddingDimensions()));
  await neo4jService.run(QUERIES.CREATE_SESSION_NOTE_CHUNK_INDEX);
  const embeddingsService = new EmbeddingsService();
  for (const chunk of chunks) {
    const embedding = await embeddingsService.embedText(chunk.content);
    await neo4jService.run(QUERIES.CREATE_SESSION_NOTE_CHUNK_QUERY, {
      noteId,
      projectId,
      parentContent: content,
      chunkId: `${noteId}_chunk_${chunk.index}`,
      chunkIndex: chunk.index,
      content: chunk.content,
      estimatedTokens: chunk.estimatedTokens,
      embedding,
      embeddingProvider: embeddingsService.provider,
      embeddingModel: embeddingsService.model,
    });
  }
  return chunks.length;
};
