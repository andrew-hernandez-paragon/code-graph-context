/** Cypher fragments shared by every query that reads SessionNote nodes bound to `n`. */

export const NOTE_NOT_EXPIRED_CLAUSE = '(n.expiresAt IS NULL OR n.expiresAt > timestamp())';

export const NOTE_NOT_SUPERSEDED_CLAUSE = 'n.supersededBy IS NULL';

/** Binds `codeNode` to each code node the note is about; session and coordination nodes are not code. */
export const NOTE_ABOUT_NODES_CLAUSE = `
  OPTIONAL MATCH (n)-[:ABOUT]->(codeNode)
  WHERE NOT codeNode:SessionNote
    AND NOT codeNode:SessionBookmark
    AND NOT codeNode:Pheromone
    AND NOT codeNode:SwarmTask`;
