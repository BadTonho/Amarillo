"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TOOL_DEFINITIONS } = require("../mcp-tools");

const INSTRUCTIONS_FILE_NAME = "plugin-instructions.md";

const PLUGIN_COMMANDS = [
  {
    name: "apply_project_tree",
    purpose: "Applies the local project snapshot in Roblox Studio.",
    notes: "Used by pull/sync flows. May return a corrected snapshot when Studio preserves classes."
  },
  {
    name: "apply_file_patch",
    purpose: "Updates a script source directly in Studio.",
    notes: "Used for fast script edits when the instance already exists."
  },
  {
    name: "run_code",
    purpose: "Runs Luau code through the plugin thread.",
    notes: "Requires a connected Studio session."
  },
  {
    name: "get_tree",
    purpose: "Returns the current synced Studio tree snapshot.",
    notes: "Includes mounts, children, script sources, selected properties, and metadata."
  },
  {
    name: "get_selection",
    purpose: "Returns the current Roblox Studio selection.",
    notes: "Useful before inspecting or editing instances."
  },
  {
    name: "playtest",
    purpose: "Starts or stops playtest from the plugin.",
    notes: "Payload mode is start or stop."
  },
  {
    name: "get_properties",
    purpose: "Reads all supported properties and attributes from an instance.",
    notes: "The path is resolved from game/service names."
  },
  {
    name: "get_descendants",
    purpose: "Lists descendants under a root instance.",
    notes: "Supports maxDepth and classFilter."
  },
  {
    name: "search_instances",
    purpose: "Searches instances by name, className, or both.",
    notes: "Can run globally or within a scope."
  },
  {
    name: "get_services",
    purpose: "Lists DataModel services visible to the plugin.",
    notes: "Includes direct child counts where readable."
  },
  {
    name: "get_instance_info",
    purpose: "Returns class, parent, children, attributes, tags, and readable properties for an instance.",
    notes: "Useful for detailed inspection."
  },
  {
    name: "get_output_log",
    purpose: "Returns recent Roblox Studio Output entries.",
    notes: "Count defaults to 50 and is capped by the daemon."
  },
  {
    name: "modify_property",
    purpose: "Changes a property or attribute on an instance.",
    notes: "Destructive. The plugin can require confirmation before applying."
  },
  {
    name: "create_instance",
    purpose: "Creates a child instance under a parent path.",
    notes: "Destructive. Initial properties are applied after creation."
  },
  {
    name: "delete_instance",
    purpose: "Deletes an instance by path.",
    notes: "Destructive. Services, Terrain, and player-controlled instances are protected."
  },
  {
    name: "insert_model",
    purpose: "Inserts the first free Marketplace model that matches a query into Workspace.",
    notes: "Destructive. Uses the same confirmation and session-health checks as the other destructive tools."
  }
];

const LOCAL_FILES = [
  {
    path: ".amarillo/errors/YYYY-MM-DD/error-tracker.json",
    purpose: "Structured daily error reports used by the daemon, plugin, and VS Code extension."
  },
  {
    path: ".amarillo/activity/YYYY-MM-DD/activity.jsonl",
    purpose: "Append-only daily machine-readable history of mounted file create/modify/delete events."
  },
  {
    path: ".amarillo/activity/YYYY-MM-DD/activity.md",
    purpose: "Human-readable daily timeline for mounted file create/modify/delete events."
  },
  {
    path: ".amarillo/activity/YYYY-MM-DD/mcp.jsonl",
    purpose: "Append-only daily machine-readable audit history for MCP/native/fallback tool calls."
  },
  {
    path: ".amarillo/activity/YYYY-MM-DD/mcp.md",
    purpose: "Human-readable daily MCP audit timeline with outcomes such as success, blocked, or declined."
  },
  {
    path: ".amarillo/plugin-instructions.md",
    purpose: "This generated reference file for plugin commands and MCP tools."
  }
];

function schemaSummary(schema) {
  if (!schema || typeof schema !== "object") {
    return "No input schema.";
  }
  const required = Array.isArray(schema.required) && schema.required.length > 0
    ? schema.required.join(", ")
    : "none";
  const properties = (Object.entries(schema.properties || {}) as any).map(([name, value]) => {
    const type = value && value.type ? value.type : "any";
    const description = value && value.description ? ` - ${value.description}` : "";
    return `    - \`${name}\` (${type})${description}`;
  });
  return [
    `  - Required: ${required}`,
    properties.length > 0 ? "  - Inputs:" : "  - Inputs: none",
    ...properties
  ].join("\n");
}

function buildInstructionsMarkdown(context: any = {}) {
  const generatedAt = new Date().toISOString();
  const workspaceRoot = context.workspaceRoot || process.cwd();
  const projectLines = (context.projects || []).map((project) => (
    `- \`${project.id}\` (${project.name || "unnamed"})`
  ));

  const commandLines = PLUGIN_COMMANDS.flatMap((command) => [
    `### ${command.name}`,
    `- Purpose: ${command.purpose}`,
    `- Notes: ${command.notes}`,
    ""
  ]);

  const toolLines = TOOL_DEFINITIONS.flatMap((tool) => [
    `### ${tool.name}`,
    `- Description: ${tool.description}`,
    schemaSummary(tool.inputSchema),
    ""
  ]);

  const localFileLines = LOCAL_FILES.map((file) => `- \`${file.path}\`: ${file.purpose}`);

  return [
    "# Amarillo Plugin Instructions",
    "",
    "> Generated automatically. Do not edit this file by hand; restart the bridge/plugin to refresh it.",
    "",
    `Generated at: ${generatedAt}`,
    `Workspace: \`${workspaceRoot}\``,
    "",
    "## How To Use",
    "",
    "- Start the Amarillo bridge from VS Code.",
    "- Open Roblox Studio, reload the Amarillo plugin if needed, and connect it to the workspace.",
    "- Run `Amarillo: Doctor` when something looks wrong; it checks workspace, sessions, sync, MCP, versions, errors, and activity in one report.",
    "- Use the MCP tools through your AI client, or use the plugin UI for connect, sync, selection, playtest, logs, and Luau execution.",
    "- Destructive operations are `modify_property`, `create_instance`, `delete_instance`, and `insert_model`; the plugin can require `Accept` or `Decline` before applying them.",
    "",
    "## Native MCP Workflow",
    "",
    "- `Amarillo: Start Bridge` writes or updates the portable `.vscode/mcp.json`, `.vscode/amarillo-mcp-bootstrap.cjs`, and local `.amarillo/mcp-local.json` state for the current workspace.",
    "- Commit `.vscode/mcp.json` and `.vscode/amarillo-mcp-bootstrap.cjs` when sharing a workspace; never commit `.amarillo/mcp-local.json` because it stores the local bridge token.",
    "- If your AI/MCP client was already open, reopen the session so it reloads the Amarillo workspace server.",
    "- In clients with native MCP support, call the Amarillo tools directly by the names documented below instead of sending raw JSON-RPC manually.",
    "- Start with `health` to confirm the daemon is online, inspect discovered projects, and collect the available `sessions[].id` values.",
    "- If the workspace has multiple projects, call `list_projects` and `set_active_project` before opening a new Studio connection or when you need to change the default target.",
    "- Any Studio tool that requires `sessionId` should reuse the `id` returned by `health`; if no session is listed, connect the Amarillo plugin in Studio first.",
    "- Safe default flow: `health` -> `list_projects` -> `get_tree` or `get_selection` -> inspection tools -> `pull_changes` or `run_code` -> destructive tools only when needed.",
    "- Use `pull_changes` when the local workspace is the source of truth and you want to apply it in Studio. Use `push_changes` when Studio has changes you want to save back to disk.",
    "",
    "## MCP Shield Fallback",
    "",
    "- If the AI client cannot see native MCP tools, the daemon still exposes the same tool layer over HTTP while the bridge is online.",
    "- Protected fallback routes require `X-Amarillo-Bridge-Token: <bridge token>`; `Authorization: Bearer <bridge token>` is also accepted for manual HTTP clients.",
    "- Check `GET /mcp/status` for config/runtime diagnostics, `GET /mcp/tools` for the tool list, and `POST /mcp/probe` to verify the fallback can call `health`.",
    "- Use `POST /mcp/call` with `{ \"name\": \"health\", \"arguments\": {} }` or any documented tool name/arguments when native MCP is unavailable.",
    "- Destructive tool responses may include `reasonCode`, `blocked`, `declined`, and `confirmed` so callers can distinguish health gates from user rejection.",
    "- In VS Code, run `Amarillo: MCP Healthcheck` to see whether `.vscode/mcp.json` and `.amarillo/mcp-local.json` are valid and to get the fallback URL.",
    "",
    "## Local Diagnostic Files",
    "",
    ...localFileLines,
    "",
    "## Active Projects",
    "",
    ...(projectLines.length > 0 ? projectLines : ["- No project discovered yet."]),
    "",
    "## Studio Plugin Commands",
    "",
    ...commandLines,
    "## MCP Tools",
    "",
    ...toolLines
  ].join("\n");
}

function ensurePluginInstructionsFile(options: any = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const outputDir = path.join(workspaceRoot, ".amarillo");
  const outputPath = path.join(outputDir, INSTRUCTIONS_FILE_NAME);
  const markdown = buildInstructionsMarkdown({
    workspaceRoot,
    projects: options.projects || []
  });

  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.existsSync(outputPath) && fs.readFileSync(outputPath, "utf8") === markdown) {
    return {
      path: outputPath,
      changed: false
    };
  }
  fs.writeFileSync(outputPath, markdown, "utf8");
  return {
    path: outputPath,
    changed: true
  };
}

module.exports = {
  INSTRUCTIONS_FILE_NAME,
  buildInstructionsMarkdown,
  ensurePluginInstructionsFile
};

