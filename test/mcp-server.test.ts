import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSeedDocuments,
  InMemoryMemoryRepository,
  InMemoryTaskRepository,
} from "../src/in-memory-adapters.js";
import { createOperatorMcpServer } from "../src/mcp-server.js";
import { OperatorService } from "../src/operator-service.js";

describe("Personal AI Operator MCP contract", () => {
  let server: ReturnType<typeof createOperatorMcpServer>;
  let client: Client;

  beforeEach(async () => {
    const service = new OperatorService(
      new InMemoryMemoryRepository(createSeedDocuments()),
      new InMemoryTaskRepository(),
    );
    server = createOperatorMcpServer(service);
    client = new Client(
      { name: "mobile-operator-test", version: "0.1.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("exposes only the six narrow MVP tools", async () => {
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name)).toEqual([
      "operator_get_current",
      "operator_get_context",
      "operator_get_progress",
      "operator_save_update",
      "operator_create_task",
      "operator_undo_memory",
    ]);
  });

  it("does not expose health or therapy as readable context modules", async () => {
    const response = await client.listTools();
    const contextTool = response.tools.find(
      (tool) => tool.name === "operator_get_context",
    );
    const moduleSchema = contextTool?.inputSchema.properties?.module as
      | { enum?: string[] }
      | undefined;

    expect(moduleSchema?.enum).not.toContain("health");
    expect(moduleSchema?.enum).not.toContain("therapy");
  });

  it("marks read-only tools as noauth for ChatGPT developer-mode connectors", async () => {
    const response = await client.listTools();

    for (const toolName of [
      "operator_get_current",
      "operator_get_context",
      "operator_get_progress",
    ]) {
      const tool = response.tools.find((item) => item.name === toolName);
      expect(tool?._meta).toMatchObject({
        securitySchemes: [{ type: "noauth" }],
      });
    }
  });

  it("marks read-only tools as oauth2 when auth is required", async () => {
    const service = new OperatorService(
      new InMemoryMemoryRepository(createSeedDocuments()),
      new InMemoryTaskRepository(),
    );
    const authServer = createOperatorMcpServer(service, {
      writesEnabled: false,
      authRequired: true,
    });
    const authClient = new Client(
      { name: "mobile-operator-auth-test", version: "0.1.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      authServer.connect(serverTransport),
      authClient.connect(clientTransport),
    ]);

    try {
      const response = await authClient.listTools();
      for (const toolName of [
        "operator_get_current",
        "operator_get_context",
        "operator_get_progress",
      ]) {
        const tool = response.tools.find((item) => item.name === toolName);
        expect(tool?._meta).toMatchObject({
          securitySchemes: [{ type: "oauth2", scopes: ["operator.read"] }],
        });
      }
    } finally {
      await Promise.all([authClient.close(), authServer.close()]);
    }
  });

  it("returns concise structured context", async () => {
    const response = await client.callTool({
      name: "operator_get_context",
      arguments: { module: "projects" },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      module: "projects",
      canonicalPath: "05-Projects/projects.md",
      version: 1,
    });
  });
});
