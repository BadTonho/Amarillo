"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  buildCodexMcpAddCommand,
  inspectCodexMcpRegistration
} = require("../vscode-extension/codex-mcp");

const workspaceRoot = path.join(os.tmpdir(), "Amarillo Test Workspace");

test("Codex MCP helper reports configured when amarillo appears in codex mcp list", async () => {
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    runCommand: async (command, args) => {
      assert.equal(command, "codex");
      assert.deepEqual(args, ["mcp", "list"]);
      return {
        exitCode: 0,
        stdout: "Name      Command  Args\namarillo  node     .vscode/amarillo-mcp-bootstrap.cjs\n",
        stderr: "",
        timedOut: false
      };
    }
  });

  assert.equal(result.status, "configured");
  assert.match(result.message, /amarillo/);
});

test("Codex MCP helper reports not_configured when codex has no amarillo server", async () => {
  const result = await inspectCodexMcpRegistration(workspaceRoot, {
    runCommand: async () => ({
      exitCode: 0,
      stdout: "No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n",
      stderr: "",
      timedOut: false
    })
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
    runCommand: async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true
    })
  });

  assert.equal(result.status, "timeout");
  assert.match(result.message, /25ms/);
});

test("Codex MCP suggested command uses only the portable workspace bootstrap", () => {
  const command = buildCodexMcpAddCommand(workspaceRoot);

  assert.match(command, /codex mcp add amarillo -- node/);
  assert.match(command, /\.vscode[\\/]amarillo-mcp-bootstrap\.cjs"/);
  assert.match(command, /--workspace "/);
  assert.doesNotMatch(command, /test-token|bridgeToken|extensionPath|amarillo\.amarillo-vscode-/);
});
