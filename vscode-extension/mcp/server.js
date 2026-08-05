"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// vscode-extension-src/mcp/server.ts
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path = __toESM(require("node:path"));
var SERVER_NAME = "amarillo";
var PROTOCOL_VERSION = "2024-11-05";
var DEFAULT_CHANGELOG_LIMIT = 2e4;
var MAX_CHANGELOG_LIMIT = 2e5;
function getExtensionRoot() {
  return import_node_path.default.resolve(__dirname, "..");
}
function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
async function readJsonFile(filePath) {
  return JSON.parse(await import_promises.default.readFile(filePath, "utf8"));
}
async function readExtensionManifest(extensionRoot = getExtensionRoot()) {
  const manifest = await readJsonFile(import_node_path.default.join(extensionRoot, "package.json"));
  const commands = Array.isArray(manifest.contributes?.commands) ? manifest.contributes.commands.map((command) => ({
    command: command.command,
    title: command.title,
    category: command.category
  })) : [];
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
    const changelogPath = import_node_path.default.join(extensionRoot, fileName);
    try {
      const content = await import_promises.default.readFile(changelogPath, "utf8");
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
    path: import_node_path.default.join(extensionRoot, "changelog.md"),
    error: "CHANGELOG.md was not found in the Amarillo extension."
  };
}
async function getHealth(extensionRoot = getExtensionRoot()) {
  let manifest = null;
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
var TOOL_DEFINITIONS = [
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
];
function isRequest(value) {
  return Object.prototype.hasOwnProperty.call(value, "id");
}
function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...data === void 0 ? {} : { data }
    }
  };
}
function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}
function validateMaxCharacters(value) {
  if (value === void 0) {
    return void 0;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_CHANGELOG_LIMIT) {
    throw new Error(`maxCharacters must be an integer between 1 and ${MAX_CHANGELOG_LIMIT}.`);
  }
  return Number(value);
}
function createAmarilloMcpServer(extensionRoot = getExtensionRoot()) {
  async function callTool(name, args = {}) {
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
  async function handleRequest(message) {
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
          return response(id, await callTool(params.name, params.arguments || {}));
        } catch (error) {
          return response(id, toolError(error instanceof Error ? error.message : String(error)));
        }
      }
      default:
        return isRequest(message) ? errorResponse(id, -32601, `Method not found: ${String(message.method || "")}`) : null;
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
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error", String(error)))}
`);
        continue;
      }
      try {
        const result = await server.handleRequest(message);
        if (result) {
          process.stdout.write(`${JSON.stringify(result)}
`);
        }
      } catch (error) {
        process.stdout.write(`${JSON.stringify(errorResponse(message.id ?? null, -32603, "Internal error", String(error)))}
`);
      }
    }
  }
}
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[amarillo-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}
`);
    process.exit(1);
  });
}
module.exports = {
  createAmarilloMcpServer,
  getHealth,
  readChangelog,
  readExtensionManifest
};
