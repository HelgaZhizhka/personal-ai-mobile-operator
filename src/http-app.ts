import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";

import {
  type AuthConfig,
  createInternalAuthorizationRedirect,
  exchangeInternalAuthorizationCode,
  getInternalAuthorizationServerMetadata,
  getProtectedResourceMetadata,
  OAuthHttpError,
  renderInternalAuthorizePage,
  sendUnauthorized,
  verifyRequestAuth,
} from "./auth.js";
import { createOperatorMcpServer } from "./mcp-server.js";
import type { OperatorService } from "./operator-service.js";

interface HttpAppOptions {
  writesEnabled?: boolean;
  buildId?: string;
  auth?: AuthConfig;
}

const setMcpCorsHeaders = (response: Response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
};

const mcpAllowedHeaders = [
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
].join(", ");

const writeToolNames = new Set([
  "operator_save_update",
  "operator_create_task",
  "operator_undo_memory",
]);

const getRequiredScope = (request: Request, auth: AuthConfig) => {
  const body = request.body as
    | { method?: string; params?: { name?: string } }
    | undefined;
  const toolName = body?.method === "tools/call" ? body.params?.name : undefined;
  return toolName && writeToolNames.has(toolName)
    ? auth.scopes.write
    : auth.scopes.read;
};

const requiresRequestAuth = (request: Request) => {
  const body = request.body as { method?: string } | undefined;
  return body?.method === "tools/call";
};

export const createHttpApp = (
  service: OperatorService,
  host: string,
  options: HttpAppOptions = {},
) => {
  const app = createMcpExpressApp({ host });
  app.use(express.urlencoded({ extended: false }));
  const writesEnabled = options.writesEnabled === true;
  const buildId = options.buildId ?? "local";
  const auth = options.auth;

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      writesEnabled,
      mode: writesEnabled ? "read-write" : "read-only",
      buildId,
      authRequired: auth?.required === true,
    });
  });

  if (auth) {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.json(getProtectedResourceMetadata(auth));
    });

    if (auth.provider === "internal") {
      const metadata = getInternalAuthorizationServerMetadata(auth);

      app.get("/.well-known/oauth-authorization-server", (_request, response) => {
        response.json(metadata);
      });

      app.get("/.well-known/openid-configuration", (_request, response) => {
        response.json(metadata);
      });

      app.get("/oauth/authorize", (request, response) => {
        response.type("html").send(renderInternalAuthorizePage(request.query));
      });

      app.post("/oauth/authorize", (request, response) => {
        try {
          response.redirect(
            302,
            createInternalAuthorizationRedirect(
              auth,
              request.body as Record<string, unknown>,
            ),
          );
        } catch (error) {
          if (
            error instanceof OAuthHttpError &&
            error.error === "access_denied"
          ) {
            response
              .status(error.status)
              .type("html")
              .send(
                renderInternalAuthorizePage(
                  request.body as Record<string, unknown>,
                  error.description,
                ),
              );
            return;
          }
          const status = error instanceof OAuthHttpError ? error.status : 500;
          const body =
            error instanceof OAuthHttpError
              ? { error: error.error, error_description: error.description }
              : { error: "server_error" };
          response.status(status).json(body);
        }
      });

      app.post("/oauth/token", (request, response) => {
        try {
          response.json(exchangeInternalAuthorizationCode(auth, request));
        } catch (error) {
          const status = error instanceof OAuthHttpError ? error.status : 500;
          const body =
            error instanceof OAuthHttpError
              ? { error: error.error, error_description: error.description }
              : { error: "server_error" };
          response.status(status).json(body);
        }
      });
    }
  }

  app.options(/^\/mcp(?:\/.*)?$/, (_request, response) => {
    response
      .status(204)
      .set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": mcpAllowedHeaders,
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      })
      .send();
  });

  app.post("/mcp", async (request, response) => {
    setMcpCorsHeaders(response);
    if (auth?.required && requiresRequestAuth(request)) {
      const requiredScope = getRequiredScope(request, auth);
      try {
        await verifyRequestAuth(request, auth, requiredScope);
      } catch (error) {
        console.warn("MCP authorization failed", error);
        sendUnauthorized(response, auth, requiredScope);
        return;
      }
    }

    const server = createOperatorMcpServer(service, {
      writesEnabled,
      authRequired: auth?.required === true,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });

  app.get("/mcp", (_request, response) => {
    setMcpCorsHeaders(response);
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.delete("/mcp", (_request, response) => {
    setMcpCorsHeaders(response);
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  return app;
};
