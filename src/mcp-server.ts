import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { readableModules, writableModules } from "./domain.js";
import type { OperatorService } from "./operator-service.js";

const readableModuleSchema = z.enum(readableModules);
const writableModuleSchema = z.enum(writableModules);
const prioritySchema = z.enum(["p1", "p2", "p3", "p4"]);
const noAuthSecuritySchemes = [{ type: "noauth" as const }];
const oauthReadSecuritySchemes = [
  { type: "oauth2" as const, scopes: ["operator.read"] },
];
const oauthWriteSecuritySchemes = [
  { type: "oauth2" as const, scopes: ["operator.write"] },
];

const emptyInputSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {},
};

type ToolSecuritySchemes =
  | typeof noAuthSecuritySchemes
  | typeof oauthReadSecuritySchemes
  | typeof oauthWriteSecuritySchemes;

const createReadOnlyTools = (securitySchemes: ToolSecuritySchemes) =>
  [
  {
    name: "operator_get_current",
    title: "Get current focus",
    description:
      "Use when Olga asks what is current, what matters now, or what she should remember today.",
    inputSchema: emptyInputSchema,
    securitySchemes,
    _meta: { securitySchemes },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "operator_get_context",
    title: "Get relevant memory context",
    description:
      "Read one allowed memory module before giving context-aware advice. Health and therapy are intentionally unavailable.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        module: {
          type: "string",
          enum: readableModules,
        },
      },
      required: ["module"],
    },
    securitySchemes,
    _meta: { securitySchemes },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "operator_get_progress",
    title: "Get active progress",
    description:
      "Use when Olga asks about progress across current directions and concrete Todoist actions.",
    inputSchema: emptyInputSchema,
    securitySchemes,
    _meta: { securitySchemes },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
  },
  ] as const;

const writeTools = [
  {
    name: "operator_save_update",
    title: "Save a durable memory update",
    description:
      "Save confirmed durable context to one allowed module. Do not use for advice, temporary thoughts, tasks, health, or therapy.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        module: { type: "string", enum: writableModules },
        expectedVersion: { type: "integer", exclusiveMinimum: 0 },
        nextContent: { type: "string", minLength: 1, maxLength: 50_000 },
        reason: { type: "string", minLength: 3, maxLength: 500 },
      },
      required: ["module", "expectedVersion", "nextContent", "reason"],
    },
    securitySchemes: oauthWriteSecuritySchemes,
    _meta: { securitySchemes: oauthWriteSecuritySchemes },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "operator_create_task",
    title: "Create one concrete Todoist task",
    description:
      "Create a specific action Olga explicitly wants to remember. Never turn ideas, advice, reference material, or obvious routine steps into tasks.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        title: { type: "string", minLength: 3, maxLength: 300 },
        due: { type: "string", maxLength: 100 },
        priority: { default: "p3", type: "string", enum: ["p1", "p2", "p3", "p4"] },
        project: { type: "string", maxLength: 200 },
      },
      required: ["title"],
    },
    securitySchemes: oauthWriteSecuritySchemes,
    _meta: { securitySchemes: oauthWriteSecuritySchemes },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "operator_undo_memory",
    title: "Undo one memory revision",
    description:
      "Restore the document version immediately before a known revision. Use only after Olga explicitly asks to undo it.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        revisionId: { type: "string", format: "uuid" },
      },
      required: ["revisionId"],
    },
    securitySchemes: oauthWriteSecuritySchemes,
    _meta: { securitySchemes: oauthWriteSecuritySchemes },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" },
  },
] as const;

const installOpenAiCompatibleToolsList = (
  server: McpServer,
  writesEnabled: boolean,
  authRequired: boolean,
) => {
  const readOnlyTools = createReadOnlyTools(
    authRequired ? oauthReadSecuritySchemes : noAuthSecuritySchemes,
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: writesEnabled ? [...readOnlyTools, ...writeTools] : readOnlyTools,
  }));
};

const toResult = (value: unknown, message: string) => ({
  structuredContent: value as Record<string, unknown>,
  content: [{ type: "text" as const, text: message }],
});

interface OperatorMcpServerOptions {
  writesEnabled?: boolean;
  authRequired?: boolean;
}

export const createOperatorMcpServer = (
  service: OperatorService,
  options: OperatorMcpServerOptions = { writesEnabled: true },
) => {
  const readSecuritySchemes =
    options.authRequired === true ? oauthReadSecuritySchemes : noAuthSecuritySchemes;
  const server = new McpServer(
    { name: "personal-ai-mobile-operator", version: "0.1.0" },
    {
      instructions:
        "Understand intent and read the minimum relevant context. Ideas and advice are not tasks. Save only durable context. Create Todoist tasks only for concrete actions. For mixed input, separate memory updates from actions. Never request health or therapy data. Ask before consequential writes. Return one next step.",
    },
  );

  server.registerTool(
    "operator_get_current",
    {
      title: "Get current focus",
      description:
        "Use when Olga asks what is current, what matters now, or what she should remember today.",
      inputSchema: {},
      _meta: { securitySchemes: readSecuritySchemes },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const snapshot = await service.getCurrent();
      return toResult(snapshot, "Current focus loaded.");
    },
  );

  server.registerTool(
    "operator_get_context",
    {
      title: "Get relevant memory context",
      description:
        "Read one allowed memory module before giving context-aware advice. Health and therapy are intentionally unavailable.",
      inputSchema: { module: readableModuleSchema },
      _meta: { securitySchemes: readSecuritySchemes },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ module }) => {
      const document = await service.getContext(module);
      return toResult(document, `Loaded ${module} context.`);
    },
  );

  server.registerTool(
    "operator_get_progress",
    {
      title: "Get active progress",
      description:
        "Use when Olga asks about progress across current directions and concrete Todoist actions.",
      inputSchema: {},
      _meta: { securitySchemes: readSecuritySchemes },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const progress = await service.getProgress();
      return toResult(progress, "Progress loaded.");
    },
  );

  if (options.writesEnabled === false) {
    installOpenAiCompatibleToolsList(server, false, options.authRequired === true);
    return server;
  }

  server.registerTool(
    "operator_save_update",
    {
      title: "Save a durable memory update",
      description:
        "Save confirmed durable context to one allowed module. Do not use for advice, temporary thoughts, tasks, health, or therapy.",
      inputSchema: {
        module: writableModuleSchema,
        expectedVersion: z.number().int().positive(),
        nextContent: z.string().min(1).max(50_000),
        reason: z.string().min(3).max(500),
      },
      _meta: { securitySchemes: oauthWriteSecuritySchemes },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await service.saveUpdate(input);
      return toResult(
        {
          module: result.document.module,
          version: result.document.version,
          revisionId: result.revision.id,
        },
        `Saved ${result.document.module} memory as version ${result.document.version}.`,
      );
    },
  );

  server.registerTool(
    "operator_create_task",
    {
      title: "Create one concrete Todoist task",
      description:
        "Create a specific action Olga explicitly wants to remember. Never turn ideas, advice, reference material, or obvious routine steps into tasks.",
      inputSchema: {
        title: z.string().min(3).max(300),
        due: z.string().max(100).optional(),
        priority: prioritySchema.default("p3"),
        project: z.string().max(200).optional(),
      },
      _meta: { securitySchemes: oauthWriteSecuritySchemes },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const task = await service.createTask(input);
      return toResult(task, `Created task: ${task.title}`);
    },
  );

  server.registerTool(
    "operator_undo_memory",
    {
      title: "Undo one memory revision",
      description:
        "Restore the document version immediately before a known revision. Use only after Olga explicitly asks to undo it.",
      inputSchema: { revisionId: z.string().uuid() },
      _meta: { securitySchemes: oauthWriteSecuritySchemes },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ revisionId }) => {
      const document = await service.undoMemory(revisionId);
      return toResult(
        { module: document.module, version: document.version },
        `Restored ${document.module} memory as version ${document.version}.`,
      );
    },
  );

  installOpenAiCompatibleToolsList(server, true, options.authRequired === true);

  return server;
};
