"use strict";

const readline = require("node:readline");

function textContent(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function startStdioMcpServer(options) {
  const {
    serverInfo,
    listTools,
    handleTool,
    protocolVersion = "2024-11-05"
  } = options;

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (_error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "JSON invalido"
        }
      })}\n`);
      continue;
    }

    const send = (payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion,
            serverInfo,
            capabilities: {
              tools: {}
            }
          }
        });
        continue;
      }

      if (message.method === "notifications/initialized") {
        continue;
      }

      if (message.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: listTools()
        });
        continue;
      }

      if (message.method === "tools/call") {
        const result = await handleTool(message.params?.name, message.params?.arguments || {});
        send({
          jsonrpc: "2.0",
          id: message.id,
          result
        });
        continue;
      }

      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported method: ${message.method}`
        }
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error.message
        }
      });
    }
  }
}

module.exports = {
  startStdioMcpServer,
  textContent
};
