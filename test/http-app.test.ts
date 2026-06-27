import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

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

  const createPkcePair = () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { challenge, verifier };
  };

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
    expect(mcpOptions.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
  });

  it("advertises OAuth metadata, exposes tool discovery, and protects tool calls", async () => {
    const service = new OperatorService(
      new InMemoryMemoryRepository(createSeedDocuments()),
      new InMemoryTaskRepository(),
    );
    const app = createHttpApp(service, "127.0.0.1", {
      buildId: "test",
      auth: {
        provider: "auth0",
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

    const toolsList = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(toolsList.status).toBe(200);
    const tools = (await toolsList.json()) as {
      result?: { tools?: Array<{ name: string; securitySchemes?: unknown[] }> };
    };
    expect(tools.result?.tools?.map((tool) => tool.name)).toEqual([
      "operator_get_current",
      "operator_get_context",
      "operator_get_progress",
    ]);
    expect(tools.result?.tools?.[0]?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["operator.read"] },
    ]);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "operator_get_current", arguments: {} },
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

  it("supports internal single-user OAuth and accepts issued access tokens", async () => {
    const service = new OperatorService(
      new InMemoryMemoryRepository(createSeedDocuments()),
      new InMemoryTaskRepository(),
    );
    const app = createHttpApp(service, "127.0.0.1", {
      buildId: "test",
      auth: {
        provider: "internal",
        required: true,
        issuer: "http://127.0.0.1",
        audience: "http://127.0.0.1",
        resource: "http://127.0.0.1",
        protectedResourceMetadataUrl:
          "http://127.0.0.1/.well-known/oauth-protected-resource",
        scopes: { read: "operator.read", write: "operator.write" },
        internal: {
          clientId: "chatgpt-test",
          clientSecret: "client-secret",
          loginPin: "123456",
          tokenSecret: "test-token-secret",
          authorizationEndpoint: "http://127.0.0.1/oauth/authorize",
          tokenEndpoint: "http://127.0.0.1/oauth/token",
          metadataUrl: "http://127.0.0.1/.well-known/oauth-authorization-server",
          codeTtlSeconds: 300,
          tokenTtlSeconds: 3600,
        },
      },
    });
    const listener = app.listen(0, "127.0.0.1");
    listeners.push(listener);

    await new Promise<void>((resolve) => listener.once("listening", resolve));
    const { port } = listener.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const { challenge, verifier } = createPkcePair();
    const redirectUri = "https://chatgpt.com/oauth/callback";
    const state = "state-123";

    const metadata = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      authorization_endpoint: "http://127.0.0.1/oauth/authorize",
      token_endpoint: "http://127.0.0.1/oauth/token",
      code_challenge_methods_supported: ["S256"],
    });

    const authorize = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: "chatgpt-test",
        redirect_uri: redirectUri,
        scope: "operator.read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "http://127.0.0.1",
        pin: "123456",
      }),
    });
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get("location");
    expect(location).toBeTruthy();
    const callback = new URL(location ?? "");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(callback.searchParams.get("state")).toBe(state);

    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "chatgpt-test",
        client_secret: "client-secret",
        code: code ?? "",
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token?: string };
    expect(tokenBody.access_token).toMatch(/^paio\./);

    const toolCall = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "operator_get_current", arguments: {} },
      }),
    });
    expect(toolCall.status).toBe(200);
    const toolResult = (await toolCall.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(toolResult.result?.content?.[0]?.text).toBe("Current focus loaded.");
  });
});
