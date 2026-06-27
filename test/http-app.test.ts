import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http-app.js";
import {
  createSeedDocuments,
  InMemoryMemoryRepository,
  InMemoryTaskRepository,
} from "../src/in-memory-adapters.js";
import { OperatorService } from "../src/operator-service.js";

describe("HTTP app", () => {
  const listeners: Array<ReturnType<ReturnType<typeof createHttpApp>["listen"]>> =
    [];

  afterEach(async () => {
    await Promise.all(
      listeners.splice(0).map(
        (listener) =>
          new Promise<void>((resolve, reject) => {
            listener.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("serves health and rejects unsupported GET MCP requests", async () => {
    const service = new OperatorService(
      new InMemoryMemoryRepository(createSeedDocuments()),
      new InMemoryTaskRepository(),
    );
    const app = createHttpApp(service, "127.0.0.1", { buildId: "test" });
    const listener = app.listen(0, "127.0.0.1");
    listeners.push(listener);

    await new Promise<void>((resolve) => listener.once("listening", resolve));
    const { port } = listener.address() as AddressInfo;

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      writesEnabled: false,
      mode: "read-only",
      buildId: "test",
      authRequired: false,
    });

    const mcpGet = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(mcpGet.status).toBe(405);
    expect(mcpGet.headers.get("allow")).toBe("POST");

    const mcpOptions = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
    });
    expect(mcpOptions.status).toBe(204);
    expect(mcpOptions.headers.get("access-control-allow-origin")).toBe("*");
    expect(mcpOptions.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });

  it("advertises OAuth protected resource metadata and rejects missing bearer tokens", async () => {
    const service = new OperatorService(
      new InMemoryMemoryRepository(createSeedDocuments()),
      new InMemoryTaskRepository(),
    );
    const app = createHttpApp(service, "127.0.0.1", {
      buildId: "test",
      auth: {
        required: true,
        issuer: "https://operator-auth.example.com/",
        audience: "https://operator.example.com",
        resource: "https://operator.example.com",
        protectedResourceMetadataUrl:
          "https://operator.example.com/.well-known/oauth-protected-resource",
        scopes: { read: "operator.read", write: "operator.write" },
      },
    });
    const listener = app.listen(0, "127.0.0.1");
    listeners.push(listener);

    await new Promise<void>((resolve) => listener.once("listening", resolve));
    const { port } = listener.address() as AddressInfo;

    const metadata = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource: "https://operator.example.com",
      authorization_servers: ["https://operator-auth.example.com/"],
      scopes_supported: ["operator.read", "operator.write"],
    });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );
    await expect(response.json()).resolves.toMatchObject({
      error: "unauthorized",
      scope: "operator.read",
    });
  });
});
