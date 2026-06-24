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
    const app = createHttpApp(service, "127.0.0.1");
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
    });

    const mcpGet = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(mcpGet.status).toBe(405);
    expect(mcpGet.headers.get("allow")).toBe("POST");
  });
});
