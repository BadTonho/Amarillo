"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "amarillo";
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
  const changelogPath = path.join(extensionRoot, "CHANGELOG.md");

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
    return {
      ok: false,
      path: changelogPath,
      error: code === "ENOENT" ? "CHANGELOG.md was not found in the Amarillo extension." : String(error)
    };
  }
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

function createAmarilloMcpServer(extensionRoot = getExtensionRoot()) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "0.1.0"
  });
  const registerTool = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, callback: (args: any) => unknown) => void;

  registerTool(
    "amarillo_health",
    {
      description: "Returns Amarillo MCP server status and read-only tool availability.",
      inputSchema: {}
    },
    async () => jsonContent(await getHealth(extensionRoot))
  );

  registerTool(
    "amarillo_get_extension_manifest",
    {
      description: "Reads useful metadata from the Amarillo VS Code extension package manifest.",
      inputSchema: {}
    },
    async () => jsonContent(await readExtensionManifest(extensionRoot))
  );

  registerTool(
    "amarillo_read_changelog",
    {
      description: "Reads the Amarillo VS Code extension changelog with an optional character limit.",
      inputSchema: {
        maxCharacters: z.number().int().min(1).max(MAX_CHANGELOG_LIMIT).optional()
      }
    },
    async ({ maxCharacters }) => {
      const result = await readChangelog(maxCharacters, extensionRoot);
      return {
        ...jsonContent(result),
        isError: result.ok === false
      };
    }
  );

  return server;
}

async function main() {
  const server = createAmarilloMcpServer();
  await server.connect(new StdioServerTransport());
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
