import type { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { QUERIES } from '../../storage/neo4j/neo4j.service.js';
import type { EmbeddingsService } from '../embeddings/embeddings.service.js';
import { debugLog } from '../utils/file-utils.js';

export interface NoteEmbeddingInput {
  noteId: string;
  projectId: string;
  topic: string;
  content: string;
}

export interface BookmarkEmbeddingInput {
  bookmarkId: string;
  projectId: string;
  taskContext: string;
  summary: string;
  findings: string;
  nextSteps: string;
}

/**
 * Embeds a saved note or bookmark and stores the vector on its node. Embedding is best effort: the
 * note or bookmark is already saved, so a failure is logged and reported as `false`, never thrown.
 */
export class SessionEmbeddingService {
  constructor(
    private readonly neo4j: Pick<Neo4jService, 'run'>,
    private readonly embeddings: Pick<EmbeddingsService, 'embedText' | 'provider' | 'model'>,
  ) {}

  embedNote(note: NoteEmbeddingInput): Promise<boolean> {
    return this.storeNoteEmbedding(note, 'Note embedding failed (non-fatal)');
  }

  /** For a note whose topic or content changed. */
  reembedNote(note: NoteEmbeddingInput): Promise<boolean> {
    return this.storeNoteEmbedding(note, 'Note re-embedding failed (non-fatal)');
  }

  async embedBookmark(bookmark: BookmarkEmbeddingInput): Promise<boolean> {
    try {
      const text = [bookmark.taskContext, bookmark.summary, bookmark.findings, bookmark.nextSteps]
        .filter((part) => part.length > 0)
        .join('\n\n');
      await this.neo4j.run(QUERIES.SET_BOOKMARK_EMBEDDING_QUERY, {
        bookmarkId: bookmark.bookmarkId,
        projectId: bookmark.projectId,
        embedding: await this.embeddings.embedText(text),
        embeddingProvider: this.embeddings.provider,
        embeddingModel: this.embeddings.model,
      });
      return true;
    } catch (error) {
      await debugLog('Bookmark embedding failed (non-fatal)', {
        error: String(error),
        bookmarkId: bookmark.bookmarkId,
      });
      return false;
    }
  }

  private async storeNoteEmbedding(note: NoteEmbeddingInput, failureMessage: string): Promise<boolean> {
    try {
      await this.neo4j.run(QUERIES.SET_NOTE_EMBEDDING_QUERY, {
        noteId: note.noteId,
        projectId: note.projectId,
        embedding: await this.embeddings.embedText(`${note.topic}\n\n${note.content}`),
        embeddingProvider: this.embeddings.provider,
        embeddingModel: this.embeddings.model,
      });
      return true;
    } catch (error) {
      await debugLog(failureMessage, { error: String(error), noteId: note.noteId });
      return false;
    }
  }
}
