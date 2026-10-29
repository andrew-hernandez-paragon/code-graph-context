/**
 * The notes anchored to the code a search found, so a code search also shows what agents
 * learned about that code. A note in any project counts, since a collection's note can be
 * anchored to a codebase's nodes.
 */

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';

import { NOTE_NOT_EXPIRED_CLAUSE, NOTE_NOT_SUPERSEDED_CLAUSE } from './session-note-query-clauses.js';

/** Enough for the gist; session_recall with the topic returns the whole note. */
const NOTE_PREVIEW_CHARS = 400;

const ANCHORED_NOTES_LIMIT = 5;

export interface AnchoredNote {
  id: string;
  projectId: string;
  topic: string;
  preview: string;
  category: string | null;
  /** The matched nodes, or the files of matched nodes, this note is anchored to. */
  anchors: string[];
}

export const ANCHORED_NOTES_QUERY = `
  CALL () {
    MATCH (n:SessionNote)-[:ABOUT]->(t)
    WHERE t.id IN $nodeIds
    RETURN n, t.id AS anchor
    UNION
    MATCH (n:SessionNote)
    WHERE any(path IN coalesce(n.aboutPaths, []) WHERE path IN $files)
    UNWIND [path IN n.aboutPaths WHERE path IN $files] AS anchor
    RETURN n, anchor
  }
  WITH n, collect(DISTINCT anchor) AS anchors
  WHERE ${NOTE_NOT_EXPIRED_CLAUSE}
    AND ${NOTE_NOT_SUPERSEDED_CLAUSE}
  RETURN n.id AS id, n.projectId AS projectId, n.topic AS topic,
         substring(coalesce(n.content, ''), 0, ${NOTE_PREVIEW_CHARS}) AS preview,
         n.category AS category, anchors
  ORDER BY size(anchors) DESC, coalesce(n.lastValidated, n.createdAt) DESC
  LIMIT ${ANCHORED_NOTES_LIMIT}
`;

export const findAnchoredNotes = async (
  neo4jService: Pick<Neo4jService, 'run'>,
  nodeIds: string[],
  files: string[],
): Promise<AnchoredNote[]> => {
  if (nodeIds.length === 0 && files.length === 0) return [];
  const rows = await neo4jService.run(ANCHORED_NOTES_QUERY, { nodeIds, files });
  return rows as AnchoredNote[];
};
