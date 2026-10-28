/**
 * Test Neo4j Connection Tool
 * Verifies Neo4j connectivity and APOC plugin availability
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  NEO4J_VERSION_FLOOR_LABEL,
  formatNeo4jVersion,
  readNeo4jVersion,
  supportsProjectFilteredSearch,
} from '../../storage/neo4j/neo4j-version.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA, MESSAGES } from '../constants.js';
import { createErrorResponse, createSuccessResponse } from '../utils.js';

export const createTestNeo4jConnectionTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.testNeo4jConnection,
    {
      title: TOOL_METADATA[TOOL_NAMES.testNeo4jConnection].title,
      description: TOOL_METADATA[TOOL_NAMES.testNeo4jConnection].description,
      annotations: TOOL_METADATA[TOOL_NAMES.testNeo4jConnection].annotations,
      inputSchema: {},
    },
    async () => {
      const neo4jService = new Neo4jService();
      const driver = neo4jService.getDriver();

      try {
        const session = driver.session();

        try {
          const basicResult = await session.run(MESSAGES.neo4j.connectionTest);
          const apocResult = await session.run(MESSAGES.neo4j.apocTest);
          const apocCount = apocResult.records[0].get('apocFunctions').toNumber();

          const message = MESSAGES.neo4j.connectionSuccess
            .replace('{}', basicResult.records[0].get('message'))
            .replace('{}', basicResult.records[0].get('timestamp'))
            .replace('{}', apocCount.toString());

          const version = await readNeo4jVersion(neo4jService);
          const versionLine =
            version === null
              ? `Neo4j version could not be read; project-filtered vector search needs ${NEO4J_VERSION_FLOOR_LABEL} or later`
              : `Neo4j ${formatNeo4jVersion(version)}: project-filtered vector search ${
                  supportsProjectFilteredSearch(version)
                    ? 'supported'
                    : `NOT supported (needs ${NEO4J_VERSION_FLOOR_LABEL} or later; run "brew upgrade neo4j" or use a ${NEO4J_VERSION_FLOOR_LABEL}+ Docker image)`
                }`;

          return createSuccessResponse(`${message}\n${versionLine}`);
        } finally {
          await session.close();
        }
      } catch (error) {
        const errorMessage = `${MESSAGES.errors.connectionTestFailed}: ${error.message}\n${MESSAGES.errors.neo4jRequirement}`;
        return createErrorResponse(errorMessage);
      } finally {
        await driver.close();
      }
    },
  );
};
