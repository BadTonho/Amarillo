"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  buildCodexMcpAddArgs,
  buildCodexMcpAddCommand,
  ensureCodexMcpRegistration,
  inspectCodexMcpRegistration
} = require("../vscode-extension/codex-mcp");

const workspaceRoot = path.join(os.tmpdir(), "Amarillo Test Workspace");
const bootstrapPath = path.join(workspaceRoot, ".vscode", "amarillo-mcp-bootstrap.cjs");

function commandResult(stdout = "", options: any = {}) {
  return {
    exitCode: options.exitCode ?? 0,
    stdout,
    stderr: options.stderr || "",
    timedOut: Boolean(options.timedOut)
  };
}

function codexGetConfig(workspace = workspaceRoot) {
  return JSON.stringify({
    command: "node",
    args: [
      path.join(workspace, ".vscode", "amarillo-mcp-bootstrap.cjs"),
      "--workspace",
      workspace
    ]
  });
}

test("Codex MCP helper reports configured when amarillo points to the current workspace", async () => {
  const calls = [];
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      if (args[1] === "list") {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      assert.deepEqual(args, ["mcp", "get", "amarillo", "--json"]);
      return commandResult(codexGetConfig());
    }
  });

  assert.equal(result.status, "configured");
  assert.match(result.message, /this workspace/);
  assert.deepEqual(calls.map((call) => call.args), [
    ["mcp", "list"],
    ["mcp", "get", "amarillo", "--json"]
  ]);
});

test("Codex MCP helper reports needs_update when amarillo points to another workspace", async () => {
  const otherWorkspace = path.join(os.tmpdir(), "Other Amarillo Workspace");
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    runCommand: async (_command, args) => {
      if (args[1] === "list") {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      return commandResult(codexGetConfig(otherWorkspace));
    }
  });

  assert.equal(result.status, "needs_update");
  assert.match(result.message, /another workspace/);
});

test("Codex MCP helper reports not_configured when codex has no amarillo server", async () => {
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    runCommand: async () => commandResult("No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n")
  });

  assert.equal(result.status, "not_configured");
  assert.match(result.suggestedCommand, /codex mcp add amarillo -- node/);
});

test("Codex MCP helper reports unavailable when codex CLI is missing", async () => {
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    runCommand: async () => {
      const error: any = new Error("spawn codex ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  });

  assert.equal(result.status, "unavailable");
  assert.match(result.message, /not found on PATH/);
});

test("Codex MCP helper reports timeout without attempting registration", async () => {
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    timeoutMs: 25,
    runCommand: async () => commandResult("", { exitCode: null, timedOut: true })
  });

  assert.equal(result.status, "timeout");
  assert.match(result.message, /25ms/);
});

test("Codex MCP registration adds amarillo with exec-safe arguments", async () => {
  const calls = [];
  const result = await ensureCodexMcpRegistration(workspaceRoot, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return commandResult("No MCP servers configured yet.\n");
      }
      if (calls.length === 2) {
        return commandResult("Added MCP server amarillo.\n");
      }
      if (calls.length === 3) {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      return commandResult(codexGetConfig());
    }
  });

  assert.equal(result.status, "registered");
  assert.equal(result.restartRequired, true);
  assert.deepEqual(calls[1], {
    command: "codex",
    args: ["mcp", "add", "amarillo", "--", "node", bootstrapPath, "--workspace", workspaceRoot]
  });
});

test("Codex MCP registration reports failure with manual command when add fails", async () => {
  const result = await ensureCodexMcpRegistration(workspaceRoot, {
    runCommand: async (_command, args) => {
      if (args[1] === "list") {
        return commandResult("No MCP servers configured yet.\n");
      }
      return commandResult("", { exitCode: 1, stderr: "permission denied" });
    }
  });

  assert.equal(result.status, "error");
  assert.match(result.message, /registration failed/);
  assert.match(result.message, /codex mcp add amarillo -- node/);
});

test("Codex MCP registration does not duplicate an existing current server", async () => {
  const calls = [];
  const result = await ensureCodexMcpRegistration(workspaceRoot, {
    runCommand: async (_command, args) => {
      calls.push(args);
      if (args[1] === "list") {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      return commandResult(codexGetConfig());
    }
  });

  assert.equal(result.status, "configured");
  assert.deepEqual(calls, [
    ["mcp", "list"],
    ["mcp", "get", "amarillo", "--json"]
  ]);
});

test("Codex MCP registration only updates a conflicting server with confirmation", async () => {
  const otherWorkspace = path.join(os.tmpdir(), "Other Amarillo Workspace");
  const calls = [];
  const result = await ensureCodexMcpRegistration(workspaceRoot, {
    confirmUpdate: async () => false,
    runCommand: async (_command, args) => {
      calls.push(args);
      if (args[1] === "list") {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      return commandResult(codexGetConfig(otherWorkspace));
    }
  });

  assert.equal(result.status, "update_declined");
  assert.deepEqual(calls, [
    ["mcp", "list"],
    ["mcp", "get", "amarillo", "--json"]
  ]);
});

test("Codex MCP registration updates a conflicting server after confirmation", async () => {
  const otherWorkspace = path.join(os.tmpdir(), "Other Amarillo Workspace");
  const calls = [];
  const result = await ensureCodexMcpRegistration(workspaceRoot, {
    confirmUpdate: async () => true,
    runCommand: async (_command, args) => {
      calls.push(args);
      if (calls.length === 1) {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      if (calls.length === 2) {
        return commandResult(codexGetConfig(otherWorkspace));
      }
      if (calls.length === 3) {
        return commandResult("Removed MCP server amarillo.\n");
      }
      if (calls.length === 4) {
        return commandResult("Added MCP server amarillo.\n");
      }
      if (calls.length === 5) {
        return commandResult("Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n");
      }
      return commandResult(codexGetConfig());
    }
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(calls[2], ["mcp", "remove", "amarillo"]);
  assert.deepEqual(calls[3], ["mcp", "add", "amarillo", "--", "node", bootstrapPath, "--workspace", workspaceRoot]);
});

test("Codex MCP suggested command uses only the portable workspace bootstrap", () => {
  const command = buildCodexMcpAddCommand(workspaceRoot);
  const args = buildCodexMcpAddArgs(workspaceRoot);

  assert.match(command, /codex mcp add amarillo -- node/);
  assert.match(command, /\.vscode[\\/]amarillo-mcp-bootstrap\.cjs"/);
  assert.match(command, /--workspace "/);
  assert.deepEqual(args, ["mcp", "add", "amarillo", "--", "node", bootstrapPath, "--workspace", workspaceRoot]);
  assert.doesNotMatch(command, /test-token|bridgeToken|extensionPath|amarillo\.amarillo-vscode-/);
  assert.doesNotMatch(JSON.stringify(args), /test-token|bridgeToken|extensionPath|amarillo\.amarillo-vscode-/);
});
