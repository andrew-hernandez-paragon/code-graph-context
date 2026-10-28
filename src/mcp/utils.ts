/**
 * MCP Server Utility Functions
 * Common utility functions used across the MCP server
 */

import { Project, ProjectService } from '../core/projects/index.js';
import { Neo4jService } from '../storage/neo4j/neo4j.service.js';

import { MESSAGES } from './constants.js';

export { debugLog } from '../core/utils/file-utils.js';

/**
 * Result type for project resolution
 */
export type ResolveProjectResult =
  | { success: true; project: Project }
  | { success: false; error: ReturnType<typeof createErrorResponse> };

const resolveWith = async (resolve: () => Promise<Project>): Promise<ResolveProjectResult> => {
  try {
    return { success: true, project: await resolve() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: createErrorResponse(message) };
  }
};

/** Read rule: an existing project of any kind, by id, name or path. */
export const findProjectOrError = (input: string, neo4jService: Neo4jService): Promise<ResolveProjectResult> =>
  resolveWith(() => new ProjectService(neo4jService).findProject(input));

/** Write rule: as the read rule, and a git root that encloses a path is registered as a directory. */
export const findOrRegisterProjectOrError = (
  input: string,
  neo4jService: Neo4jService,
): Promise<ResolveProjectResult> => resolveWith(() => new ProjectService(neo4jService).findOrRegisterProject(input));

export type ResolveProjectsResult =
  | { success: true; projects: Project[] }
  | { success: false; error: ReturnType<typeof createErrorResponse> };

/** Read rule for several inputs: every project found once, or one error naming each input that failed. */
export const findProjectsOrError = async (
  inputs: readonly string[],
  neo4jService: Neo4jService,
): Promise<ResolveProjectsResult> => {
  const projectService = new ProjectService(neo4jService);
  const outcomes = await Promise.allSettled(inputs.map((input) => projectService.findProject(input)));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === 'rejected'
      ? [`'${inputs[index]}': ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
      : [],
  );
  if (failures.length > 0) {
    return {
      success: false,
      error: createErrorResponse(`${failures.length} of ${inputs.length} projects not found. ${failures.join(' | ')}`),
    };
  }
  const found = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
  return { success: true, projects: [...new Map(found.map((project) => [project.projectId, project])).values()] };
};

/** Code rule: a parsed codebase; a directory or collection gets an error naming the next step. */
export const findCodebaseOrError = (input: string, neo4jService: Neo4jService): Promise<ResolveProjectResult> =>
  resolveWith(() => new ProjectService(neo4jService).findCodebase(input));

/**
 * Auto-resolve a codebase when the id is omitted. If only one codebase exists, use it.
 * If multiple exist, return error listing them. If none, return error.
 */
export const resolveSoleCodebaseOrError = async (
  projectId: string | undefined,
  neo4jService: Neo4jService,
): Promise<ResolveProjectResult> => {
  if (projectId) {
    return findCodebaseOrError(projectId, neo4jService);
  }

  return resolveWith(async () => {
    const codebases = await new ProjectService(neo4jService).list(['codebase']);
    if (codebases.length === 0) {
      throw new Error('No parsed codebases found. Use parse_typescript_project to add one first.');
    }
    if (codebases.length > 1) {
      const projectList = codebases.map((p) => `  - ${p.name} (${p.projectId})`).join('\n');
      throw new Error(`Multiple codebases found. Specify projectId:\n${projectList}`);
    }
    return codebases[0];
  });
};

/**
 * Standard error response format for MCP tools
 */
export const createErrorResponse = (
  error: Error | string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } => {
  const errorMessage = error instanceof Error ? error.message : error;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${MESSAGES.errors.genericError} ${errorMessage}`,
      },
    ],
  };
};

/**
 * Standard success response format for MCP tools
 */
export const createSuccessResponse = (text: string): { content: Array<{ type: 'text'; text: string }> } => {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
};

/**
 * Standard "no results" response for MCP tools.
 * Use instead of createSuccessResponse for empty result sets.
 */
export const createEmptyResponse = (
  message: string,
  suggestion?: string,
  warnings: readonly string[] = [],
): { content: Array<{ type: 'text'; text: string }> } => {
  return createSuccessResponse(
    JSON.stringify({
      status: 'empty',
      message,
      ...(suggestion && { suggestion }),
      ...(warnings.length > 0 && { warnings }),
    }),
  );
};

/**
 * Adds to the `warnings` of a JSON object response, keeping any the tool already reported.
 * A plain-text response is kept as `message` so the result is always JSON.
 */
export const withWarnings = (responseText: string, warnings: readonly string[]): string => {
  if (warnings.length === 0) return responseText;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(responseText);
    payload =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { message: responseText };
  } catch {
    payload = { message: responseText };
  }
  const existing = Array.isArray(payload.warnings) ? (payload.warnings as unknown[]) : [];
  return JSON.stringify({ ...payload, warnings: [...existing, ...warnings] });
};

/**
 * Result type for code truncation
 */
export interface TruncateCodeResult {
  text: string;
  truncated?: number;
  hasMore?: boolean;
}

/**
 * Truncate code to specified max length, showing first and last portions
 */
export const truncateCode = (code: string, maxLength: number): TruncateCodeResult => {
  if (code.length <= maxLength) {
    return { text: code };
  }
  const half = Math.floor(maxLength / 2);
  return {
    text: code.substring(0, half) + '\n\n... [truncated] ...\n\n' + code.substring(code.length - half),
    hasMore: true,
    truncated: code.length - maxLength,
  };
};

/**
 * Format node information as structured data
 */
export const formatNodeInfo = (value: any, key: string): any => {
  if (value && typeof value === 'object' && value.labels && value.properties) {
    // Return structured node data
    const result: any = {
      id: value.properties.id,
      type: value.labels[0] ?? 'Unknown',
      filePath: value.properties.filePath,
    };

    if (value.properties.name) {
      result.name = value.properties.name;
    }

    // Include source code if available and not a SourceFile
    if (value.properties.sourceCode && value.properties.coreType !== 'SourceFile') {
      const truncateResult = truncateCode(value.properties.sourceCode, 1000);
      result.sourceCode = truncateResult.text;
      if (truncateResult.hasMore) {
        result.hasMore = truncateResult.hasMore;
        result.truncated = truncateResult.truncated;
      }
    }

    return result;
  } else if (value && typeof value === 'object' && value.type) {
    // Return structured relationship data
    return {
      relationshipType: value.type,
      properties: value.properties,
    };
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Handle record objects (e.g., {rd.filePath: "...", rd.name: "..."})
    const formatted: any = {};
    Object.keys(value).forEach((k) => {
      formatted[k] = formatNodeInfo(value[k], k);
    });
    return formatted;
  } else {
    // Return primitive as-is
    return value;
  }
};

/**
 * Format results for the natural language to cypher tool
 */
export const formatQueryResults = (results: any[], query: string, cypherResult: any): any => {
  const formattedResults = results.map((record) => formatNodeInfo(record, 'result'));

  return {
    query,
    cypher: cypherResult.cypher,
    parameters: cypherResult.parameters ?? {},
    explanation: cypherResult.explanation,
    totalResults: results.length,
    results: formattedResults,
  };
};

/**
 * Validate and sanitize numeric inputs
 */
export const sanitizeNumericInput = (value: number | string, defaultValue: number, max?: number): number => {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : value;

  if (isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }

  if (max !== undefined && parsed > max) {
    return max;
  }

  return parsed;
};

/**
 * Safe JSON parse with fallback
 */
export const safeJsonParse = (json: string, fallback: any = null): any => {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
};

/**
 * Format success message for parsing results
 */
export const formatParseSuccess = (nodeCount: number, edgeCount: number, result?: any): string => {
  let message = `${MESSAGES.success.parseSuccess} Parsed ${nodeCount} nodes and ${edgeCount} edges. Graph imported to Neo4j.`;

  if (result) {
    message += ` Result: ${JSON.stringify(result)}`;
  }

  return message;
};

/**
 * Format partial success message for parsing results
 */
export const formatParsePartialSuccess = (
  nodeCount: number,
  edgeCount: number,
  outputPath: string,
  errorMessage: string,
): string => {
  return `${MESSAGES.success.partialSuccess} Parsed ${nodeCount} nodes and ${edgeCount} edges. JSON saved to ${outputPath}. Neo4j import failed: ${errorMessage}`;
};
