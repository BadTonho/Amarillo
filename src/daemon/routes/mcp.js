"use strict";

const { handleTool: handleMcpTool } = require("../mcp");
const {
  listTools,
  mcpShieldSummary,
  mcpToolResultToHttpPayload
} = require("../mcp-shield");
const { jsonResponse, readJsonBody } = require("../http-utils");

async function handleMcpRoutes(app, request, response, requestUrl) {
  if (request.method === "GET" && requestUrl.pathname === "/mcp/status") {
    jsonResponse(response, 200, {
      ok: true,
      mcp: mcpShieldSummary(app)
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/debug/mcp-state") {
    jsonResponse(response, 200, {
      ok: true,
      timestamp: new Date().toISOString(),
      mcp: mcpShieldSummary(app)
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/mcp/tools") {
    const tools = listTools();
    jsonResponse(response, 200, {
      ok: true,
      toolCount: tools.tools.length,
      ...tools,
      mcp: mcpShieldSummary(app)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/mcp/probe") {
    try {
      const result = await handleMcpTool(app, "health", {}, { source: "http_probe" });
      jsonResponse(response, 200, {
        ok: true,
        probe: "health",
        mcp: mcpShieldSummary(app),
        ...mcpToolResultToHttpPayload(result)
      });
    } catch (error) {
      jsonResponse(response, 502, {
        ok: false,
        error: error.message,
        mcp: mcpShieldSummary(app)
      });
    }
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/mcp/call") {
    const body = await readJsonBody(request);
    const toolName = String(body.name || body.tool || "");
    if (!toolName) {
      jsonResponse(response, 400, {
        ok: false,
        error: "Missing MCP tool name. Send { \"name\": \"health\", \"arguments\": {} }."
      });
      return true;
    }
    try {
      const source = request.headers["x-amarillo-mcp-proxy"] ? "proxy_http" : "http_fallback";
      const result = await handleMcpTool(app, toolName, body.arguments || body.args || {}, { source });
      jsonResponse(response, 200, {
        ok: true,
        name: toolName,
        mcp: mcpShieldSummary(app),
        ...mcpToolResultToHttpPayload(result)
      });
    } catch (error) {
      jsonResponse(response, 502, {
        ok: false,
        name: toolName,
        error: error.message,
        mcp: mcpShieldSummary(app)
      });
    }
    return true;
  }

  return false;
}

module.exports = {
  handleMcpRoutes
};
