"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const events = require("node:events");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const serverPath = path.join(repoRoot, "vscode-extension", "mcp", "server.js");

function createRpcClient() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(repoRoot, "vscode-extension"),
    stdio: ["pipe", "pipe", "pipe"]
  });

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  async function nextMessage() {
    const timeoutMs = 5000;
    return Promise.race([
      events.once(rl, "line").then(([line]) => JSON.parse(line)),
      events.once(child, "exit").then(([code, signal]) => {
        throw new Error(`server exited early code=${code} signal=${signal}\n${stderr}`);
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`timeout waiting for MCP response\n${stderr}`));
        }, timeoutMs);
      })
    ]);
  }

  return {
    async notify(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async request(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return nextMessage();
    },
    async close() {
      rl.close();
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (!child.killed) {
        child.kill();
      }
      await events.once(child, "exit");
    }
  };
}

function toolPayload(response) {
  const content = response.result.content;
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

test("bundled Amarillo MCP server exposes read-only Codex tools", async () => {
  const client = createRpcClient();

  try {
    const initialize = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "tests",
          version: "1.0.0"
        }
      }
    });
    assert.equal(initialize.result.serverInfo.name, "amarillo");

    await client.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    const list = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });
    const toolNames = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "amarillo_get_extension_manifest",
      "amarillo_health",
      "amarillo_read_changelog"
    ]);

    const health = await client.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "amarillo_health",
        arguments: {}
      }
    });
    assert.equal(toolPayload(health).ok, true);

    const manifest = await client.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "amarillo_get_extension_manifest",
        arguments: {}
      }
    });
    assert.equal(toolPayload(manifest).name, "amarillo-vscode");

    const changelog = await client.request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "amarillo_read_changelog",
        arguments: {
          maxCharacters: 128
        }
      }
    });
    const changelogPayload = toolPayload(changelog);
    assert.equal(changelogPayload.ok, true);
    assert.ok(changelogPayload.content.length <= 128);
  } finally {
    await client.close();
  }
});
