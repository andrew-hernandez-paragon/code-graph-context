/**
 * Hello Tool
 * Simple test tool to verify MCP connection
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOL_NAMES, TOOL_METADATA, MESSAGES } from '../constants.js';
import { createSuccessResponse, debugLog } from '../utils.js';

import { logToolCallStart, logToolCallEnd } from './index.js';

export const createHelloTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.hello,
    {
      title: TOOL_METADATA[TOOL_NAMES.hello].title,
      description: TOOL_METADATA[TOOL_NAMES.hello].description,
      annotations: TOOL_METADATA[TOOL_NAMES.hello].annotations,
      inputSchema: {},
    },
    async () => {
      const startTime = Date.now();
      const callId = await logToolCallStart('hello');
      try {
        const result = createSuccessResponse(MESSAGES.success.hello);
        await logToolCallEnd('hello', callId, true, Date.now() - startTime);
        return result;
      } catch (error) {
        await debugLog('Hello tool error', { error: String(error) });
        await logToolCallEnd('hello', callId, false, Date.now() - startTime);
        throw error;
      }
    },
  );
};
