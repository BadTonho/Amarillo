"use strict";

import fs from "node:fs/promises";
import path from "node:path";

const SERVER_NAME = "amarillo";
const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_CHANGELOG_LIMIT = 20_000;
const MAX_CHANGELOG_LIMIT = 200_000;

type ExtensionManifest = {
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  publisher?: string;
  main?: string;
  engines?: Record<string, string>;
  categories?: string[];
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{
      command?: string;
      title?: string;
      category?: string;
    }>;
  };
};

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

function getExtensionRoot() {
  return path.resolve(__dirname, "..");
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readExtensionManifest(extensionRoot = getExtensionRoot()) {
  const manifest = await readJsonFile<ExtensionManifest>(path.join(extensionRoot, "package.json"));
  const commands = Array.isArray(manifest.contributes?.commands)
    ? manifest.contributes.commands.map((command) => ({
      command: command.command,
      title: command.title,
      category: command.category
    }))
    : [];

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    publisher: manifest.publisher,
    main: manifest.main,
    engines: manifest.engines,
    categories: manifest.categories || [],
    activationEvents: manifest.activationEvents || [],
    commandCount: commands.length,
    commands
  };
}

async function readChangelog(maxCharacters = DEFAULT_CHANGELOG_LIMIT, extensionRoot = getExtensionRoot()) {
  const limit = Math.min(Math.max(Math.floor(maxCharacters || DEFAULT_CHANGELOG_LIMIT), 1), MAX_CHANGELOG_LIMIT);
  const changelogCandidates = ["changelog.md", "CHANGELOG.md"];

  for (const fileName of changelogCandidates) {
    const changelogPath = path.join(extensionRoot, fileName);
    try {
      const content = await fs.readFile(changelogPath, "utf8");
      const truncated = content.length > limit;
      return {
        ok: true,
        path: changelogPath,
        maxCharacters: limit,
        characters: Math.min(content.length, limit),
        truncated,
        content: truncated ? content.slice(0, limit) : content
      };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN";
      if (code !== "ENOENT") {
        return {
          ok: false,
          path: changelogPath,
          error: String(error)
        };
      }
    }
  }

  return {
    ok: false,
    path: path.join(extensionRoot, "changelog.md"),
    error: "CHANGELOG.md was not found in the Amarillo extension."
  };
}

async function getHealth(extensionRoot = getExtensionRoot()) {
  let manifest: Awaited<ReturnType<typeof readExtensionManifest>> | null = null;
  try {
    manifest = await readExtensionManifest(extensionRoot);
  } catch (_error) {
    manifest = null;
  }

  return {
    ok: true,
    server: {
      name: SERVER_NAME,
      version: manifest?.version || "0.0.0"
    },
    extensionRoot,
    readOnly: true,
    tools: [
      "amarillo_health",
      "amarillo_get_extension_manifest",
      "amarillo_read_changelog"
    ]
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "amarillo_health",
    description: "Returns Amarillo MCP server status and read-only tool availability.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "amarillo_get_extension_manifest",
    description: "Reads useful metadata from the Amarillo VS Code extension package manifest.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "amarillo_read_changelog",
    description: "Reads the Amarillo VS Code extension changelog with an optional character limit.",
    inputSchema: {
      type: "object",
      properties: {
        maxCharacters: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CHANGELOG_LIMIT
        }
      },
      additionalProperties: false
    }
  }
] as const;

function isRequest(value: JsonRpcRequest) {
  return Object.prototype.hasOwnProperty.call(value, "id");
}

function response(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

function validateMaxCharacters(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_CHANGELOG_LIMIT) {
    throw new Error(`maxCharacters must be an integer between 1 and ${MAX_CHANGELOG_LIMIT}.`);
  }
  return Number(value);
}

function createAmarilloMcpServer(extensionRoot = getExtensionRoot()) {
  async function callTool(name: unknown, args: Record<string, unknown> = {}) {
    switch (name) {
      case "amarillo_health":
        return jsonContent(await getHealth(extensionRoot));
      case "amarillo_get_extension_manifest":
        return jsonContent(await readExtensionManifest(extensionRoot));
      case "amarillo_read_changelog": {
        const result = await readChangelog(validateMaxCharacters(args.maxCharacters), extensionRoot);
        return {
          ...jsonContent(result),
          isError: result.ok === false
        };
      }
      default:
        return toolError(`Unknown tool: ${String(name)}`);
    }
  }

  async function handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message.id ?? null;
    const params = message.params || {};

    switch (message.method) {
      case "initialize":
        return response(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: SERVER_NAME,
            version: "0.1.0"
          }
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, { tools: TOOL_DEFINITIONS });
      case "tools/call": {
        try {
          return response(id, await callTool(params.name, (params.arguments || {}) as Record<string, unknown>));
        } catch (error) {
          return response(id, toolError(error instanceof Error ? error.message : String(error)));
        }
      }
      default:
        return isRequest(message)
          ? errorResponse(id, -32601, `Method not found: ${String(message.method || "")}`)
          : null;
    }
  }

  return {
    handleRequest,
    callTool
  };
}

async function main() {
  const server = createAmarilloMcpServer();
  let input = "";

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += String(chunk);
    const lines = input.split(/\r?\n/);
    input = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch (error) {
        process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error", String(error)))}\n`);
        continue;
      }

      try {
        const result = await server.handleRequest(message);
        if (result) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
      } catch (error) {
        process.stdout.write(`${JSON.stringify(errorResponse(message.id ?? null, -32603, "Internal error", String(error)))}\n`);
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[amarillo-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  createAmarilloMcpServer,
  getHealth,
  readChangelog,
  readExtensionManifest
};
