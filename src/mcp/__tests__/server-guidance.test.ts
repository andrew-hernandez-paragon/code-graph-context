import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readPackageVersion } from '../../core/utils/package-version.js';
import { MCP_SERVER_CONFIG, SERVER_INSTRUCTIONS, TOOL_NAMES } from '../constants.js';
import { createMcpServer } from '../create-server.js';

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

describe('MCP server guidance, read through a client', () => {
  let client: Client;
  let tools: ListedTool[];

  beforeAll(async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'guidance-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client.close();
  });

  it('registers exactly the tools named in TOOL_NAMES', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL_NAMES).sort());
  });

  it('gives every tool a title, a description and explicit annotations', () => {
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
      const readOnly = tool.annotations?.readOnlyHint;
      expect(typeof readOnly, `${tool.name} readOnlyHint`).toBe('boolean');
      if (readOnly === false) {
        expect(typeof tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean');
      }
    }
  });

  it('marks the deleting tools destructive and the read tools read-only', () => {
    const annotationsOf = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
    expect(annotationsOf('cleanup_session')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf('swarm_cleanup')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf('search_codebase')).toMatchObject({ readOnlyHint: true });
    expect(annotationsOf('session_recall')).toMatchObject({ readOnlyHint: true });
    expect(annotationsOf('create_project')).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  it('sends instructions that name only registered tools', async () => {
    const instructions = client.getInstructions();
    expect(instructions).toBe(SERVER_INSTRUCTIONS);

    const mentioned = instructions?.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    expect(mentioned.length).toBeGreaterThan(5);
    const registered = new Set(tools.map((tool) => tool.name));
    expect(mentioned.filter((name) => !registered.has(name))).toEqual([]);
  });

  it('keeps the instructions short, since every client pays for them in every session', () => {
    expect(SERVER_INSTRUCTIONS.split('\n').length).toBeLessThanOrEqual(30);
  });

  it('reports the package name and version', () => {
    expect(client.getServerVersion()).toEqual({ name: 'code-graph-context', version: readPackageVersion() });
    expect(MCP_SERVER_CONFIG.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('createErrorResponse', () => {
  it('sets isError so a client can tell a failure from a result', async () => {
    const { createErrorResponse } = await import('../utils.js');
    const response = createErrorResponse(new Error('Project not found'));
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Project not found');
  });
});
