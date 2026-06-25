import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Response } from "express";

import { createOperatorMcpServer } from "./mcp-server.js";
import type { OperatorService } from "./operator-service.js";

interface HttpAppOptions {
  writesEnabled?: boolean;
  buildId?: string;
}

const setMcpCorsHeaders = (response: Response) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
};

export const createHttpApp = (
  service: OperatorService,
  host: string,
  options: HttpAppOptions = {},
) => {
  const app = createMcpExpressApp({ host });
  const writesEnabled = options.writesEnabled === true;
  const buildId = options.buildId ?? "local";

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      writesEnabled,
      mode: writesEnabled ? "read-write" : "read-only",
      buildId,
    });
  });

  app.options(/^\/mcp(?:\/.*)?$/, (_request, response) => {
    response
      .status(204)
      .set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      })
      .send();
  });

  app.post("/mcp", async (request, response) => {
    setMcpCorsHeaders(response);
    const server = createOperatorMcpServer(service, {
      writesEnabled,
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
