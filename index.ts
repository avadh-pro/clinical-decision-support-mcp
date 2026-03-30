import "dotenv/config";
import * as tools from "./tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { IMcpTool } from "./IMcpTool";
import cors from "cors";

// Bind to all interfaces. No allowedHosts restriction — the MCP server is stateless
// and authenticated via SHARP headers, so host-based filtering adds no security value
// and breaks tunnels, proxies, and cloud deployments.
const app = createMcpExpressApp({
  host: "0.0.0.0",
});

const port = process.env["PORT"] || 5000;

app.use(cors());

app.get("/hello-world", async (_, res) => {
  res.send("Hello World");
});

app.get("/health", async (_, res) => {
  res.json({ status: "ok", server: "Clinical Decision Support MCP Server" });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = new McpServer(
      {
        name: "Clinical Decision Support MCP Server",
        version: "1.0.0",
      },
      {
        capabilities: {
          experimental: {
            fhir_context_required: {
              value: true,
            },
          },
        },
      },
    );

    for (const tool of Object.values<IMcpTool>(tools)) {
      tool.registerTool(server, req);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      console.log("Request closed");

      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.log("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.listen(port, () => {
  console.log(`MCP server listening on port ${port}`);

  // Keep-alive: self-ping every 4 minutes to prevent Render cold starts (50s spin-up)
  const keepAliveUrl = process.env["RENDER_EXTERNAL_URL"];
  if (keepAliveUrl) {
    const FOUR_MINUTES = 4 * 60 * 1000;
    setInterval(async () => {
      try {
        await fetch(`${keepAliveUrl}/health`);
        console.log("Keep-alive ping sent");
      } catch {
        console.warn("Keep-alive ping failed");
      }
    }, FOUR_MINUTES);
  }
});
