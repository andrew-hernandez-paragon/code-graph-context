/**
 * MCP Tool Factory
 * Centralized tool creation and registration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createCheckParseStatusTool } from './check-parse-status.tool.js';
import { createDetectDeadCodeTool } from './detect-dead-code.tool.js';
import { createDetectDuplicateCodeTool } from './detect-duplicate-code.tool.js';
import { createHelloTool } from './hello.tool.js';
import { createImpactAnalysisTool } from './impact-analysis.tool.js';
import { createListProjectsTool } from './list-projects.tool.js';
import { createListWatchersTool } from './list-watchers.tool.js';
import { createNaturalLanguageToCypherTool } from './natural-language-to-cypher.tool.js';
import { createParseTypescriptProjectTool } from './parse-typescript-project.tool.js';
import { createSearchCodebaseTool } from './search-codebase.tool.js';
import { createCleanupSessionTool } from './session-cleanup.tool.js';
import { createSessionRecallTool } from './session-recall.tool.js';
import { createSessionSaveTool } from './session-save.tool.js';
import { createSessionUpdateTool } from './session-update.tool.js';
import { createStartWatchProjectTool } from './start-watch-project.tool.js';
import { createStopWatchProjectTool } from './stop-watch-project.tool.js';
import { createSwarmAdvanceTaskTool } from './swarm-advance-task.tool.js';
import { createSwarmClaimTaskTool } from './swarm-claim-task.tool.js';
import { createSwarmCleanupTool } from './swarm-cleanup.tool.js';
import { createSwarmCompleteTaskTool } from './swarm-complete-task.tool.js';
import { createSwarmGetTasksTool } from './swarm-get-tasks.tool.js';
import { createSwarmMessageTool } from './swarm-message.tool.js';
import { createSwarmPheromoneTool } from './swarm-pheromone.tool.js';
import { createSwarmPostTaskTool } from './swarm-post-task.tool.js';
import { createSwarmReleaseTaskTool } from './swarm-release-task.tool.js';
import { createSwarmSenseTool } from './swarm-sense.tool.js';
import { createTestNeo4jConnectionTool } from './test-neo4j-connection.tool.js';
import { createTraverseFromNodeTool } from './traverse-from-node.tool.js';

// Track tool calls for debugging
let globalToolCallCount = 0;

/**
 * Log tool call start (exported for use by individual tools)
 */
export const logToolCallStart = async (_toolName: string, _params?: unknown): Promise<number> => {
  globalToolCallCount++;
  return globalToolCallCount;
};

/**
 * Log tool call end (exported for use by individual tools)
 */
export const logToolCallEnd = async (
  _toolName: string,
  _callId: number,
  _success: boolean,
  _duration?: number,
): Promise<void> => {
  // No-op - verbose logging disabled
};

/**
 * Register all MCP tools with the server
 */
export const registerAllTools = (server: McpServer): void => {
  // Register basic tools
  createHelloTool(server);
  createTestNeo4jConnectionTool(server);

  // Register core functionality tools
  createSearchCodebaseTool(server);
  createTraverseFromNodeTool(server);
  createNaturalLanguageToCypherTool(server);
  createImpactAnalysisTool(server);
  createDetectDeadCodeTool(server);
  createDetectDuplicateCodeTool(server);

  // Register project parsing tools
  createParseTypescriptProjectTool(server);
  createCheckParseStatusTool(server);

  // Register project management tools
  createListProjectsTool(server);

  // Register file watch tools
  createStartWatchProjectTool(server);
  createStopWatchProjectTool(server);
  createListWatchersTool(server);

  // Register swarm coordination tools (pheromones for indirect coordination)
  createSwarmPheromoneTool(server);
  createSwarmSenseTool(server);
  createSwarmCleanupTool(server);

  // Register swarm task tools (blackboard for explicit task management)
  createSwarmPostTaskTool(server);
  createSwarmClaimTaskTool(server);
  createSwarmAdvanceTaskTool(server);
  createSwarmReleaseTaskTool(server);
  createSwarmCompleteTaskTool(server);
  createSwarmGetTasksTool(server);

  // Register swarm messaging tools (direct agent-to-agent communication)
  createSwarmMessageTool(server);

  // Register session tools (unified save/recall + cleanup + in-place update)
  createSessionSaveTool(server);
  createSessionRecallTool(server);
  createSessionUpdateTool(server);
  createCleanupSessionTool(server);
};
