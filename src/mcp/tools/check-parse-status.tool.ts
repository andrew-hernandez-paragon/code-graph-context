/**
 * Check Parse Status Tool
 * Returns the status of an async parsing job
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { jobManager, ParseJob } from '../services/job-manager.js';
import { createErrorResponse, createSuccessResponse } from '../utils.js';

const formatProgress = (job: ParseJob): string => {
  const { progress } = job;
  const progressPct = progress.filesTotal > 0 ? Math.round((progress.filesProcessed / progress.filesTotal) * 100) : 0;
  const unit = progress.phase === 'resolving' ? 'edges' : 'files';

  const lines = [
    `Status: ${job.status}`,
    `Phase: ${progress.phase}`,
    `Progress: ${progressPct}% (${progress.filesProcessed}/${progress.filesTotal} ${unit})`,
  ];

  if (progress.totalChunks > 0) {
    lines.push(`Chunk: ${progress.currentChunk}/${progress.totalChunks}`);
  }

  lines.push(`Nodes: ${progress.nodesImported}`);
  lines.push(`Edges: ${progress.edgesImported}`);

  return lines.join('\n');
};

const formatCompleted = (job: ParseJob): string => {
  if (!job.result) {
    return 'Parsing completed (no result data)';
  }

  return [
    `Parsing completed!`,
    ``,
    `Nodes: ${job.result.nodesImported}`,
    `Edges: ${job.result.edgesImported}`,
    `Time: ${(job.result.elapsedMs / 1000).toFixed(2)}s`,
    `Project ID: ${job.projectId}`,
  ].join('\n');
};

const formatFailed = (job: ParseJob): string => {
  return `Parsing failed: ${job.error ?? 'Unknown error'}`;
};

export const createCheckParseStatusTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.checkParseStatus,
    {
      title: TOOL_METADATA[TOOL_NAMES.checkParseStatus].title,
      description: TOOL_METADATA[TOOL_NAMES.checkParseStatus].description,
      annotations: TOOL_METADATA[TOOL_NAMES.checkParseStatus].annotations,
      inputSchema: {
        jobId: z.string().describe('Job ID returned from async parse_typescript_project'),
      },
    },
    async ({ jobId }) => {
      const job = jobManager.getJob(jobId);

      if (!job) {
        return createErrorResponse(`Job not found: ${jobId}\n\nJobs are automatically cleaned up after 1 hour.`);
      }

      switch (job.status) {
        case 'completed':
          return createSuccessResponse(formatCompleted(job));

        case 'failed':
          return createErrorResponse(formatFailed(job));

        case 'pending':
        case 'running':
        default:
          return createSuccessResponse(formatProgress(job));
      }
    },
  );
};
