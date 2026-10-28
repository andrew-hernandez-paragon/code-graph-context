/**
 * Builds the MCP server with its identity, instructions and every tool registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MCP_SERVER_CONFIG, SERVER_INSTRUCTIONS } from './constants.js';
import { registerAllTools } from './tools/index.js';

export const createMcpServer = (): McpServer => {
  const server = new McpServer(
    { name: MCP_SERVER_CONFIG.name, version: MCP_SERVER_CONFIG.version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server);
  return server;
};
