import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { readableModules, writableModules } from "./domain.js";
import type { OperatorService } from "./operator-service.js";

const readableModuleSchema = z.enum(readableModules);
const writableModuleSchema = z.enum(writableModules);
const prioritySchema = z.enum(["p1", "p2", "p3", "p4"]);
const noAuthSecuritySchemes = [{ type: "noauth" as const }];

const toResult = (value: unknown, message: string) => ({
  structuredContent: value as Record<string, unknown>,
  content: [{ type: "text" as const, text: message }],
});

interface OperatorMcpServerOptions {
  writesEnabled?: boolean;
}

export const createOperatorMcpServer = (
  service: OperatorService,
  options: OperatorMcpServerOptions = { writesEnabled: true },
) => {
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
      _meta: { securitySchemes: noAuthSecuritySchemes },
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
      _meta: { securitySchemes: noAuthSecuritySchemes },
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
      _meta: { securitySchemes: noAuthSecuritySchemes },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const progress = await service.getProgress();
      return toResult(progress, "Progress loaded.");
    },
  );

  if (options.writesEnabled === false) {
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

  return server;
};
