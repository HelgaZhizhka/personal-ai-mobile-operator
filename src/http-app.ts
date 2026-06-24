import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createOperatorMcpServer } from "./mcp-server.js";
import type { OperatorService } from "./operator-service.js";

export const createHttpApp = (service: OperatorService, host: string) => {
  const app = createMcpExpressApp({ host });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/mcp", async (request, response) => {
    const server = createOperatorMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
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
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  return app;
};
