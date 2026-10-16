import { describe, expect, it } from 'vitest';

import { SENSE_PHEROMONES_FOR_SIGNALS } from '../../../mcp/tools/query-signals.tool.js';
import { CREATE_BOOKMARK_QUERY as BOOKMARK_TOOL_CREATE_BOOKMARK_QUERY } from '../../../mcp/tools/session-bookmark.tool.js';
import { CREATE_SESSION_NOTE_QUERY as NOTE_TOOL_CREATE_NOTE_QUERY } from '../../../mcp/tools/session-note.tool.js';
import {
  CREATE_BOOKMARK_QUERY as SAVE_CREATE_BOOKMARK_QUERY,
  CREATE_SESSION_NOTE_QUERY as SAVE_CREATE_NOTE_QUERY,
} from '../../../mcp/tools/session-save.tool.js';
import { RECREATE_NOTE_ABOUT_EDGES_QUERY } from '../../../mcp/tools/session-update.tool.js';
import { CREATE_PHEROMONE_QUERY } from '../../../mcp/tools/swarm-pheromone.tool.js';
import { CREATE_TASK_QUERY, GET_NODES_FOR_FILE_QUERY } from '../../../mcp/tools/swarm-post-task.tool.js';
import { SENSE_PHEROMONES_QUERY } from '../../../mcp/tools/swarm-sense.tool.js';
import { QUERIES } from '../neo4j.service.js';

// Without a label Neo4j cannot use an index and scans every node in the database.
const labelledLookups: Array<[string, string, string]> = [
  ['DELETE_SOURCE_FILE_SUBGRAPHS', QUERIES.DELETE_SOURCE_FILE_SUBGRAPHS, 'MATCH (n:GraphNode)'],
  ['GET_CROSS_FILE_EDGES', QUERIES.GET_CROSS_FILE_EDGES, 'MATCH (n:GraphNode)'],
  [
    'RECREATE_CROSS_FILE_EDGES start',
    QUERIES.RECREATE_CROSS_FILE_EDGES,
    'MATCH (startNode:GraphNode {id: edge.startNodeId, projectId: $projectId})',
  ],
  [
    'RECREATE_CROSS_FILE_EDGES end',
    QUERIES.RECREATE_CROSS_FILE_EDGES,
    'MATCH (endNode:GraphNode {id: edge.endNodeId, projectId: $projectId})',
  ],
  [
    'RECREATE_ABOUT_EDGES',
    QUERIES.RECREATE_ABOUT_EDGES,
    'MATCH (target:GraphNode {id: aboutId, projectId: $projectId})',
  ],
  [
    'RECREATE_REFERENCES_EDGES',
    QUERIES.RECREATE_REFERENCES_EDGES,
    'MATCH (target:GraphNode {id: targetId, projectId: $projectId})',
  ],
  [
    'RECREATE_MARKS_EDGES',
    QUERIES.RECREATE_MARKS_EDGES,
    'MATCH (target:GraphNode {id: p.nodeId, projectId: $projectId})',
  ],
  [
    'COUNT_STALE_ABOUT_REFS',
    QUERIES.COUNT_STALE_ABOUT_REFS,
    'OPTIONAL MATCH (target:GraphNode {id: aboutId, projectId: $projectId})',
  ],
  ['GET_EXISTING_NODES_FOR_EDGE_DETECTION', QUERIES.GET_EXISTING_NODES_FOR_EDGE_DETECTION, 'MATCH (n:GraphNode)'],
  ['GET_NODE_BY_ID', QUERIES.GET_NODE_BY_ID, 'MATCH (n:GraphNode {id: $nodeId, projectId: $projectId})'],
  ['GET_NODE_IMPACT', QUERIES.GET_NODE_IMPACT, 'MATCH (target:GraphNode {id: $nodeId, projectId: $projectId})'],
  ['GET_FILE_NODE_IDS', QUERIES.GET_FILE_NODE_IDS, 'MATCH (n:GraphNode {projectId: $projectId, filePath: $filePath})'],
  ['GET_NODES_IMPACT', QUERIES.GET_NODES_IMPACT, 'MATCH (target:GraphNode) WHERE target.id IN $nodeIds'],
  [
    'GET_NODES_TRANSITIVE_DEPENDENTS',
    QUERIES.GET_NODES_TRANSITIVE_DEPENDENTS(3),
    'MATCH (target:GraphNode) WHERE target.id IN $nodeIds',
  ],
  [
    'GET_TRANSITIVE_DEPENDENTS',
    QUERIES.GET_TRANSITIVE_DEPENDENTS(3),
    'MATCH (target:GraphNode {id: $nodeId, projectId: $projectId})',
  ],
  [
    'session_update RECREATE_NOTE_ABOUT_EDGES_QUERY',
    RECREATE_NOTE_ABOUT_EDGES_QUERY,
    'MATCH (target:GraphNode {id: aboutId, projectId: $projectId})',
  ],
  [
    'session_save CREATE_SESSION_NOTE_QUERY',
    SAVE_CREATE_NOTE_QUERY,
    'OPTIONAL MATCH (target:GraphNode {id: aboutNodeId, projectId: $projectId})',
  ],
  [
    'session_note CREATE_SESSION_NOTE_QUERY',
    NOTE_TOOL_CREATE_NOTE_QUERY,
    'OPTIONAL MATCH (target:GraphNode {id: aboutNodeId, projectId: $projectId})',
  ],
  ['session_save CREATE_BOOKMARK_QUERY', SAVE_CREATE_BOOKMARK_QUERY, 'OPTIONAL MATCH (target:GraphNode)'],
  ['session_bookmark CREATE_BOOKMARK_QUERY', BOOKMARK_TOOL_CREATE_BOOKMARK_QUERY, 'OPTIONAL MATCH (target:GraphNode)'],
  [
    'swarm_pheromone CREATE_PHEROMONE_QUERY',
    CREATE_PHEROMONE_QUERY,
    'MATCH (target:GraphNode {id: $nodeId, projectId: $projectId})',
  ],
  ['swarm_post_task GET_NODES_FOR_FILE_QUERY', GET_NODES_FOR_FILE_QUERY, 'MATCH (n:GraphNode {projectId: $projectId})'],
  ['swarm_post_task CREATE_TASK_QUERY', CREATE_TASK_QUERY, 'OPTIONAL MATCH (target:GraphNode)'],
  [
    'swarm_sense SENSE_PHEROMONES_QUERY',
    SENSE_PHEROMONES_QUERY,
    'OPTIONAL MATCH (target:GraphNode {id: p.nodeId, projectId: p.projectId})',
  ],
  [
    'query_signals SENSE_PHEROMONES_FOR_SIGNALS',
    SENSE_PHEROMONES_FOR_SIGNALS,
    'OPTIONAL MATCH (target:GraphNode {id: p.nodeId, projectId: p.projectId})',
  ],
];

describe('node lookups carry the GraphNode label', () => {
  it.each(labelledLookups)('%s', (_name, query, expectedMatch) => {
    expect(query).toContain(expectedMatch);
  });

  it('recreate queries no longer filter targets by excluded labels', () => {
    for (const query of [
      QUERIES.RECREATE_ABOUT_EDGES,
      QUERIES.RECREATE_REFERENCES_EDGES,
      QUERIES.RECREATE_MARKS_EDGES,
      RECREATE_NOTE_ABOUT_EDGES_QUERY,
    ]) {
      expect(query).not.toContain('NOT target:');
    }
  });
});

describe('GraphNode index statements', () => {
  it('creates the filePath and name indexes beside the id index', () => {
    expect(QUERIES.CREATE_PROJECT_FILEPATH_INDEX_GRAPHNODE).toBe(
      'CREATE INDEX project_filepath_graphnode_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.projectId, n.filePath)',
    );
    expect(QUERIES.CREATE_PROJECT_NAME_INDEX_GRAPHNODE).toBe(
      'CREATE INDEX project_name_graphnode_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.projectId, n.name)',
    );
  });
});
