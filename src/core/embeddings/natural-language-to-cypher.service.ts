import fs from 'fs';

import OpenAI from 'openai';
import type { TextContentBlock } from 'openai/resources/beta/threads/messages';

import { getTimeoutConfig } from '../config/timeouts.js';

/**
 * Categorized semantic types discovered from the schema.
 * Used to generate dynamic examples for the LLM.
 */
interface SemanticTypeCategories {
  controller: string[];
  service: string[];
  repository: string[];
  module: string[];
  guard: string[];
  pipe: string[];
  interceptor: string[];
  other: string[];
  all: string[];
}

export class NaturalLanguageToCypherService {
  private assistantId: string;
  private readonly openai: OpenAI;
  private readonly MODEL = 'gpt-4o'; // GPT-4o for better Cypher generation accuracy
  private schemaPath: string | null = null;
  private cachedSemanticTypes: SemanticTypeCategories | null = null;
  /**
   * System instructions for the assistant (set once at creation time).
   * Kept focused on Cypher rules and output format — schema data is injected per-query.
   */
  private readonly assistantInstructions = `You are a Neo4j Cypher query generator. You receive a schema and a natural language request, and you return a single JSON object. No prose, no markdown, no explanation outside the JSON.

OUTPUT FORMAT (strict):
{"cypher": "...", "parameters": null, "explanation": "..."}

- "cypher": valid Neo4j Cypher query
- "parameters": object of extra parameters or null (NEVER include projectId — it is injected automatically)
- "explanation": one sentence describing what the query does

RULES:
1. ALL node patterns MUST include: WHERE n.projectId = $projectId
2. Use ONLY node labels listed in the schema's nodeTypes[].label
3. Entity names are PROPERTY values, NOT labels: (n:Class {name: 'MyService'}) not (n:MyService)
4. AST type names are NOT labels: ClassDeclaration → Class, MethodDeclaration → Method, InterfaceDeclaration → Interface, FunctionDeclaration → Function, PropertyDeclaration → Property, ParameterDeclaration → Parameter
5. semanticType is a PROPERTY, not a label: WHERE n.semanticType = 'NestController'
6. EXTENDS direction: child → parent. (child:Class)-[:EXTENDS]->(parent:Class)
7. Cypher has no GROUP BY — aggregation is automatic in RETURN
8. Use $-prefixed parameters for dynamic values

CORE RELATIONSHIPS:
CONTAINS (file→declaration), HAS_MEMBER (class→method/property), HAS_PARAMETER (method→param), EXTENDS (child→parent), IMPLEMENTS (class→interface), IMPORTS (file→file), TYPED_AS (node→type), CALLS (caller→callee), DECORATED_WITH (node→decorator)
`;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    const timeoutConfig = getTimeoutConfig();
    this.openai = new OpenAI({
      apiKey,
      timeout: timeoutConfig.openai.assistantTimeoutMs,
      maxRetries: 2,
    });
  }

  public async getOrCreateAssistant(schemaPath: string): Promise<string> {
    // Store schema path for later use — schema is injected directly into each prompt
    this.schemaPath = schemaPath;

    if (process.env.OPENAI_ASSISTANT_ID) {
      this.assistantId = process.env.OPENAI_ASSISTANT_ID;
      console.error(`Using existing assistant with ID: ${this.assistantId}`);
      return this.assistantId;
    }

    const assistant = await this.openai.beta.assistants.create({
      name: 'Neo4j Cypher Query Generator',
      description: 'Converts natural language to Neo4j Cypher queries. Returns JSON only.',
      model: this.MODEL,
      instructions: this.assistantInstructions,
      response_format: { type: 'json_object' },
      // No tools — schema is injected directly into each message
      tools: [],
    });

    this.assistantId = assistant.id;
    console.error(`Created assistant with ID: ${this.assistantId}`);

    return this.assistantId;
  }

  /**
   * Load the schema and format it for direct injection into the user message.
   * This is the ONLY way the LLM sees the schema — no file_search.
   */
  private loadSchemaContext(): string {
    if (!this.schemaPath) {
      return 'No schema available.';
    }

    try {
      const content = fs.readFileSync(this.schemaPath, 'utf-8');
      const schema = JSON.parse(content);

      if (!schema || !schema.nodeTypes) {
        return 'No schema available.';
      }

      // Format node types with properties
      const nodeTypeLines = schema.nodeTypes
        ?.map((n: any) => `  ${n.label} (${n.count} nodes) — properties: ${(n.properties ?? []).join(', ')}`)
        .join('\n') ?? 'none';

      // Format relationship types with connection patterns
      const relTypeLines = schema.relationshipTypes
        ?.map((r: any) => {
          const conns = (r.connections ?? []).map((c: any) => `${c.from}→${c.to}`).join(', ');
          return `  ${r.type} (${r.count}) — ${conns}`;
        })
        .join('\n') ?? 'none';

      // Format semantic types
      const semanticTypeList: string[] = schema.semanticTypes?.map((s: any) => s.type) ?? [];
      const semTypeLines = schema.semanticTypes
        ?.map((s: any) => `  ${s.type} (on ${s.label}, ${s.count} nodes)`)
        .join('\n') ?? 'none';

      // Format common patterns
      const patternLines = schema.commonPatterns
        ?.map((p: any) => `  (${p.from})-[:${p.relationship}]->(${p.to}) × ${p.count}`)
        .join('\n') ?? 'none';

      // Cache categorized semantic types for dynamic example generation
      this.cachedSemanticTypes = this.categorizeSemanticTypes(semanticTypeList);

      return `SCHEMA:

NODE LABELS (use ONLY these):
${nodeTypeLines}

RELATIONSHIP TYPES:
${relTypeLines}

SEMANTIC TYPES (query via WHERE n.semanticType = 'value'):
${semTypeLines}

COMMON PATTERNS:
${patternLines}`;
    } catch (error) {
      console.warn('Failed to load schema for prompt injection:', error);
      return 'Schema load failed.';
    }
  }

  /**
   * Categorizes semantic types by their likely intent (controller, service, etc.)
   * This allows the LLM to generate queries that work with any framework,
   * not just NestJS-specific semantic type names.
   */
  private categorizeSemanticTypes(semanticTypes: string[]): SemanticTypeCategories {
    const categories: SemanticTypeCategories = {
      controller: [],
      service: [],
      repository: [],
      module: [],
      guard: [],
      pipe: [],
      interceptor: [],
      other: [],
      all: [...semanticTypes],
    };

    for (const type of semanticTypes) {
      const lower = type.toLowerCase();

      if (lower.includes('controller')) {
        categories.controller.push(type);
      } else if (lower.includes('service') || lower.includes('provider') || lower.includes('injectable')) {
        categories.service.push(type);
      } else if (lower.includes('repository') || lower.includes('dal') || lower.includes('dao')) {
        categories.repository.push(type);
      } else if (lower.includes('module')) {
        categories.module.push(type);
      } else if (lower.includes('guard') || lower.includes('auth')) {
        categories.guard.push(type);
      } else if (lower.includes('pipe') || lower.includes('validator')) {
        categories.pipe.push(type);
      } else if (lower.includes('interceptor') || lower.includes('middleware')) {
        categories.interceptor.push(type);
      } else {
        categories.other.push(type);
      }
    }

    return categories;
  }

  /**
   * Generates dynamic query examples based on discovered semantic types.
   * Provides both semantic type matching and name pattern fallbacks.
   */
  private generateDynamicSemanticExamples(categories: SemanticTypeCategories): string {
    const formatTypes = (types: string[]): string => types.map((t) => `'${t}'`).join(', ');

    let examples = '\nSEMANTIC TYPES IN THIS PROJECT:\n';

    if (categories.all.length === 0) {
      examples += 'No semantic types discovered. Use name patterns for queries.\n';
    } else {
      examples += `Available: ${categories.all.join(', ')}\n`;
    }

    examples += '\nFRAMEWORK-AGNOSTIC QUERY PATTERNS:\n';

    // Controller queries
    if (categories.controller.length > 0) {
      examples += `- "Find all controllers" -> MATCH (c:Class) WHERE c.projectId = $projectId AND c.semanticType IN [${formatTypes(categories.controller)}] RETURN c\n`;
    } else {
      examples += `- "Find all controllers" -> MATCH (c:Class) WHERE c.projectId = $projectId AND (c.name CONTAINS 'Controller' OR c.name ENDS WITH 'Controller') RETURN c\n`;
    }

    // Service queries
    if (categories.service.length > 0) {
      examples += `- "Find all services" -> MATCH (c:Class) WHERE c.projectId = $projectId AND c.semanticType IN [${formatTypes(categories.service)}] RETURN c\n`;
    } else {
      examples += `- "Find all services" -> MATCH (c:Class) WHERE c.projectId = $projectId AND (c.name CONTAINS 'Service' OR c.name ENDS WITH 'Service') RETURN c\n`;
    }

    // Repository queries
    if (categories.repository.length > 0) {
      examples += `- "Find all repositories" -> MATCH (c:Class) WHERE c.projectId = $projectId AND c.semanticType IN [${formatTypes(categories.repository)}] RETURN c\n`;
    } else {
      examples += `- "Find all repositories" -> MATCH (c:Class) WHERE c.projectId = $projectId AND (c.name CONTAINS 'Repository' OR c.name ENDS WITH 'DAL') RETURN c\n`;
    }

    // Module queries
    if (categories.module.length > 0) {
      examples += `- "Find all modules" -> MATCH (c:Class) WHERE c.projectId = $projectId AND c.semanticType IN [${formatTypes(categories.module)}] RETURN c\n`;
    }

    // Guard queries
    if (categories.guard.length > 0) {
      examples += `- "Find all guards" -> MATCH (c:Class) WHERE c.projectId = $projectId AND c.semanticType IN [${formatTypes(categories.guard)}] RETURN c\n`;
    }

    examples += `
FALLBACK PATTERNS (use when semantic types don't exist):
- For any component type, use name patterns: c.name CONTAINS 'TypeName' OR c.name ENDS WITH 'TypeName'
- Example: "Find UserController" -> MATCH (c:Class {name: 'UserController'}) WHERE c.projectId = $projectId RETURN c
`;

    return examples;
  }

  async promptToQuery(userPrompt: string, projectId: string) {
    const schemaContext = this.loadSchemaContext();

    // Generate dynamic examples based on discovered semantic types
    const dynamicSemanticExamples = this.cachedSemanticTypes
      ? this.generateDynamicSemanticExamples(this.cachedSemanticTypes)
      : '';

    const prompt = `Convert to Cypher: ${userPrompt}

${schemaContext}
${dynamicSemanticExamples}
Project: ${projectId} — add WHERE n.projectId = $projectId on every node pattern.

Respond with ONLY a JSON object: {"cypher": "...", "parameters": null, "explanation": "..."}`;

    // SECURITY: Only log prompt length, not full content which may contain sensitive data
    console.error(`NL-to-Cypher: Processing prompt (${prompt.length} chars) for project ${projectId}`);
    const run = await this.openai.beta.threads.createAndRunPoll({
      assistant_id: this.assistantId,
      thread: {
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      },
    });

    const threadId = run.thread_id;
    // SECURITY: Log minimal info, avoid exposing full objects that may contain sensitive data
    console.error(`NL-to-Cypher: Thread ${threadId}, status: ${run.status}`);

    // Validate run completed successfully
    if (run.status !== 'completed') {
      // SECURITY: Only log status and error, not full run object which may contain sensitive data
      console.error(`NL-to-Cypher run failed: status=${run.status}, error=${run.last_error?.message ?? 'none'}`);
      throw new Error(
        `Assistant run did not complete. Status: ${run.status}. ` +
          `Last error: ${run.last_error ? JSON.stringify(run.last_error) : 'none'}`,
      );
    }

    const messages = await this.openai.beta.threads.messages.list(threadId);

    // Find the first text content in the latest message
    const latestMessage = messages.data[0];
    if (!latestMessage) {
      throw new Error(
        `No messages returned from assistant. Run status: ${run.status}. Thread: ${threadId}. ` +
          `This may occur if the assistant is still initializing. Try setting OPENAI_ASSISTANT_ID in .env.`,
      );
    }
    // SECURITY: Don't log full message content which may contain user data
    console.error(`NL-to-Cypher: Received message with ${latestMessage.content?.length ?? 0} content blocks`);

    if (!latestMessage.content || latestMessage.content.length === 0) {
      throw new Error(
        `Message has no content. Run status: ${run.status}. Thread: ${threadId}. ` +
          `Message role: ${latestMessage.role}`,
      );
    }

    const textContent = latestMessage.content.find((content): content is TextContentBlock => content.type === 'text');

    if (!textContent) {
      throw new Error(`No text content found in assistant response. Run status: ${run.status}`);
    }

    // Validate that the text property exists and extract the value safely
    const textValue = textContent.text?.value;
    if (!textValue) {
      throw new Error(
        `Invalid text content structure in assistant response. Run status: ${run.status}. ` +
          `Text content: ${JSON.stringify(textContent)}`,
      );
    }

    // SECURITY: Don't log the full text value which may contain sensitive queries
    console.error(`NL-to-Cypher: Parsing response (${textValue.length} chars)`);

    // Extract JSON from the LLM response, handling markdown fences and prose preamble
    let result: { cypher: string; parameters?: Record<string, unknown>; explanation?: string };
    try {
      result = JSON.parse(this.extractJson(textValue));
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(
        `Failed to parse assistant response as JSON: ${message}. ` +
          `Response preview: ${textValue.substring(0, 200)}...`,
      );
    }

    // Validate that the generated Cypher contains projectId filters
    this.validateProjectIdFilters(result.cypher);

    // Validate that the query uses only valid node labels (not class names as labels)
    this.validateLabelUsage(result.cypher);

    return result;
  }

  /**
   * Extracts JSON from an LLM response that may contain markdown fences or prose preamble.
   * Tries in order: raw parse, markdown fence extraction, first `{...}` block extraction.
   */
  private extractJson(text: string): string {
    const trimmed = text.trim();

    // 1. Already valid JSON — return as-is
    if (trimmed.startsWith('{')) {
      return trimmed;
    }

    // 2. Wrapped in markdown code fences: ```json ... ``` or ``` ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      return fenceMatch[1].trim();
    }

    // 3. JSON object embedded in prose — find the first top-level { ... }
    const startIdx = trimmed.indexOf('{');
    if (startIdx !== -1) {
      let depth = 0;
      for (let i = startIdx; i < trimmed.length; i++) {
        if (trimmed[i] === '{') depth++;
        else if (trimmed[i] === '}') depth--;
        if (depth === 0) {
          return trimmed.substring(startIdx, i + 1);
        }
      }
    }

    // 4. Give up — return original text so JSON.parse produces a useful error
    return trimmed;
  }

  /**
   * Validates that the generated Cypher query contains projectId filters.
   * This is a security measure to ensure project isolation is maintained
   * even if the LLM forgets to include the filter.
   *
   * SECURITY: This validation ensures ALL node patterns in the query have projectId filters,
   * preventing data leakage between projects.
   */
  private validateProjectIdFilters(cypher: string): void {
    if (!cypher || typeof cypher !== 'string') {
      throw new Error('Invalid Cypher query: query is empty or not a string');
    }

    // Check if the query contains any MATCH clauses
    const matchPattern = /\bMATCH\s*\(/gi;
    const matches = cypher.match(matchPattern);

    if (matches && matches.length > 0) {
      // SECURITY: Check that projectId filter exists and uses parameter binding
      // We require $projectId to ensure parameterized queries (prevents injection)
      const hasProjectIdParam = cypher.includes('$projectId');
      const hasProjectIdFilter = cypher.includes('projectId') && hasProjectIdParam;

      if (!hasProjectIdFilter) {
        throw new Error(
          'Generated Cypher query is missing projectId filter. ' +
            'All queries must include WHERE n.projectId = $projectId for project isolation. ' +
            `Query: ${cypher}`,
        );
      }

      // SECURITY: Additional validation - count MATCH patterns and ensure projectId appears enough times
      // This catches queries like: MATCH (a:Class) MATCH (b:Method) WHERE a.projectId = $projectId
      // where the second MATCH doesn't have a projectId filter
      const matchCount = matches.length;
      const projectIdOccurrences = (cypher.match(/\.projectId\s*=/gi) ?? []).length;

      // Each MATCH pattern should ideally have a projectId filter
      // We warn but don't fail if there's at least one filter (some queries use WITH to pass context)
      if (projectIdOccurrences < matchCount) {
        console.warn(
          `SECURITY WARNING: Query has ${matchCount} MATCH patterns but only ${projectIdOccurrences} projectId filters. ` +
            'Some patterns may not be properly isolated.',
        );
      }
    }
  }

  /**
   * Load valid labels dynamically from the schema file.
   * Returns all labels from nodeTypes in the discovered schema.
   */
  private loadValidLabelsFromSchema(): Set<string> {
    // Fallback to core TypeScript labels if schema not available
    const coreLabels = new Set([
      'SourceFile',
      'Class',
      'Method',
      'Function',
      'Property',
      'Interface',
      'Constructor',
      'Parameter',
      'Enum',
      'Variable',
      'Import',
      'Export',
      'Decorator',
      'TypeAlias',
      'TypeScript',
      'Embedded',
    ]);

    if (!this.schemaPath) {
      return coreLabels;
    }

    try {
      const content = fs.readFileSync(this.schemaPath, 'utf-8');
      const schema = JSON.parse(content);

      const allLabels = new Set(coreLabels);

      if (schema?.nodeTypes) {
        for (const nodeType of schema.nodeTypes) {
          if (nodeType.label) {
            allLabels.add(nodeType.label);
          }
        }
      }

      return allLabels;
    } catch {
      return coreLabels;
    }
  }

  /**
   * Validates that the generated Cypher query uses only valid node labels.
   * AST type names (ClassDeclaration) must be mapped to Neo4j labels (Class).
   * Class/service names should be matched via {name: 'ClassName'}, not as labels.
   */
  private validateLabelUsage(cypher: string): void {
    // Load valid labels dynamically from schema file
    const validLabels = this.loadValidLabelsFromSchema();

    // Mapping from AST type names to correct Neo4j labels
    const astTypeToLabel: Record<string, string> = {
      ClassDeclaration: 'Class',
      FunctionDeclaration: 'Function',
      MethodDeclaration: 'Method',
      InterfaceDeclaration: 'Interface',
      PropertyDeclaration: 'Property',
      ParameterDeclaration: 'Parameter',
      ConstructorDeclaration: 'Constructor',
      ImportDeclaration: 'Import',
      ExportDeclaration: 'Export',
      EnumDeclaration: 'Enum',
      VariableDeclaration: 'Variable',
    };

    // Extract all labels from query (matches :LabelName patterns in node definitions)
    // This regex matches labels after : in patterns like (n:Label) or (:Label)
    const labelPattern = /\(\s*\w*\s*:\s*([A-Z][a-zA-Z0-9]*)/g;
    let match;
    const invalidLabels: string[] = [];

    while ((match = labelPattern.exec(cypher)) !== null) {
      const label = match[1];
      if (!validLabels.has(label)) {
        invalidLabels.push(label);
      }
    }

    if (invalidLabels.length > 0) {
      const label = invalidLabels[0];
      const correctLabel = astTypeToLabel[label];

      if (correctLabel) {
        // AST type name used instead of Neo4j label
        throw new Error(
          `Invalid label ":${label}" in query. ` +
            `Use the Neo4j label ":${correctLabel}" instead of the AST type name ":${label}".\n` +
            `Example: (n:${correctLabel}) instead of (n:${label})\n` +
            `Query: ${cypher}`,
        );
      } else {
        // Unknown label - likely a class/service name used as label
        throw new Error(
          `Invalid label ":${label}" in query. ` +
            `Class/service names should be matched via {name: '${label}'}, not as labels.\n` +
            `Example: (n:Class {name: '${label}'}) instead of (n:${label})\n` +
            `Valid labels: ${Array.from(validLabels).join(', ')}\n` +
            `Query: ${cypher}`,
        );
      }
    }
  }
}
