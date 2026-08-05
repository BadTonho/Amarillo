"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const events = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { TOOL_DEFINITIONS } = require("../src/daemon/mcp-tools");
const { TOOL_HANDLERS } = require("../src/daemon/mcp");
const { textContent } = require("../src/daemon/mcp-stdio");
const { isLoopbackHost, hostForUrl, resolveBridgeOptions, requestJson } = require("../src/mcp-proxy");
const { createTempDirectory } = require("./helpers/test-temp");

function createTempWorkspace() {
  return createTempDirectory("amarillo-mcp-proxy-");
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port
  };
}

function createRpcClient(workspaceRoot, port, bridgeToken = null) {
  const args = [
    path.join(__dirname, "..", "src", "mcp-proxy", "index.js"),
    "--workspace",
    workspaceRoot,
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ];
  if (bridgeToken) {
    args.push("--bridge-token", bridgeToken);
  }
  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, ".."),
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
        throw new Error(`proxy exited early code=${code} signal=${signal}\n${stderr}`);
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`timeout waiting for proxy response\n${stderr}`));
        }, timeoutMs);
      })
    ]);
  }

  return {
    child,
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

function toolText(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("proxy auth mode ignores loopback tokens and preserves external tokens", async () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(resolveBridgeOptions({
    workspaceRoot: createTempWorkspace(),
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "local-token"
  }).bridgeToken, null);
  assert.equal(resolveBridgeOptions({
    workspaceRoot: createTempWorkspace(),
    host: "0.0.0.0",
    port: 8323,
    bridgeToken: "external-token"
  }).bridgeToken, "external-token");

  let receivedHeader;
  const { server, port } = await startMockServer(async (request, response) => {
    receivedHeader = request.headers["x-amarillo-bridge-token"];
    writeJson(response, 200, { ok: true });
  });
  try {
    await requestJson(`http://127.0.0.1:${port}`, "POST", "/mcp/call", {}, {
      bridgeToken: "external-token"
    });
    assert.equal(receivedHeader, "external-token");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("advertised MCP tools are implemented by the daemon and generic proxy handler", () => {
  const proxySource = fs.readFileSync(path.join(__dirname, "..", "src", "mcp-proxy", "index.js"), "utf8");

  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(typeof TOOL_HANDLERS[tool.name], "function", `${tool.name} missing from daemon MCP handlers`);
  }
  assert.match(proxySource, /SUPPORTED_TOOLS/);
  assert.doesNotMatch(proxySource, /case "run_code"/);
});

test("mcp proxy answers initialize, tools/list and health through HTTP", async () => {
  const workspace = createTempWorkspace();
  const seenRequests = [];
  const seenHeaders = [];
  const { server, port } = await startMockServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    seenRequests.push({
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : null
    });
    seenHeaders.push(request.headers["x-amarillo-bridge-token"]);
    if (request.method === "POST" && request.url === "/mcp/call") {
      writeJson(response, 200, {
        ok: true,
        name: "health",
        result: textContent({
          workspaceRoot: workspace,
          projects: [
            {
              id: "ExampleGame.project.json",
              name: "ExampleGame"
            }
          ],
          sessions: [
            {
              id: "session-1",
              projectName: "Example"
            }
          ]
        })
      });
      return;
    }
    writeJson(response, 404, { ok: false, error: "not found" });
  });

  const client = createRpcClient(workspace, port, "saved-local-token");

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
    assert.equal(initialize.result.serverInfo.name, "amarillo-mcp-proxy");

    await client.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    const tools = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });
    assert.ok(tools.result.tools.some((tool) => tool.name === "health"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "run_code"));

    const health = await client.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "health",
        arguments: {}
      }
    });
    const payload = toolText(health.result);
    assert.equal(payload.workspaceRoot, workspace);
    assert.equal(payload.projects[0].name, "ExampleGame");
    assert.equal(payload.sessions[0].id, "session-1");
    assert.deepEqual(seenRequests, [
      {
        method: "POST",
        url: "/mcp/call",
        body: {
          name: "health",
          arguments: {}
        }
      }
    ]);
    assert.deepEqual(seenHeaders, [undefined]);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("mcp proxy forwards set_active_project, get_tree, inspect_instance and run_code", async () => {
  const workspace = createTempWorkspace();
  const requests = [];
  const snapshot = {
    mounts: [
      {
        id: "ServerScriptService",
        segments: ["ServerScriptService"],
        children: [
          {
            name: "Hello",
            className: "ModuleScript",
            children: []
          }
        ]
      }
    ]
  };
  const { server, port } = await startMockServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }

    requests.push({
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : null
    });

    if (request.method === "POST" && request.url === "/mcp/call") {
      const toolName = body ? JSON.parse(body).name : null;
      const args = body ? JSON.parse(body).arguments : {};
      writeJson(response, 200, {
        ok: true,
        name: toolName,
        result: textContent(
          toolName === "set_active_project"
            ? {
              id: "ExampleGame.project.json",
              name: "ExampleGame"
            }
            : (toolName === "connect_session"
              ? {
                ok: true,
                sessionId: "session-1",
                session: {
                  id: "session-1",
                  projectName: "ExampleGame"
                },
                project: {
                  id: "ExampleGame.project.json",
                  name: "ExampleGame"
                }
              }
              : (toolName === "get_tree"
                ? {
                  mounts: [
                    {
                      id: "ServerScriptService",
                      segments: ["ServerScriptService"],
                      children: [
                        {
                          name: "Hello",
                          className: "ModuleScript",
                          children: []
                        }
                      ]
                    }
                  ]
                }
                : (toolName === "inspect_instance"
                  ? {
                    name: "Hello",
                    className: "ModuleScript",
                    path: args.path
                  }
                  : {
                    ok: true,
                    output: "ran"
                  })))
        )
      });
      return;
    }

    writeJson(response, 404, {
      ok: false,
      error: "not found"
    });
  });

  const client = createRpcClient(workspace, port);

  try {
    await client.request({
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
    await client.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    const setProject = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "set_active_project",
        arguments: {
          projectId: "ExampleGame.project.json"
        }
      }
    });
    assert.equal(toolText(setProject.result).name, "ExampleGame");

    const connectSession = await client.request({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "connect_session",
        arguments: {
          projectId: "ExampleGame.project.json",
          placeId: 123
        }
      }
    });
    assert.equal(toolText(connectSession.result).sessionId, "session-1");

    const tree = await client.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_tree",
        arguments: {
          sessionId: "session-1"
        }
      }
    });
    assert.deepEqual(toolText(tree.result), snapshot);

    const inspect = await client.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "inspect_instance",
        arguments: {
          sessionId: "session-1",
          path: "game.ServerScriptService.Hello"
        }
      }
    });
    const node = toolText(inspect.result);
    assert.equal(node.name, "Hello");
    assert.equal(node.className, "ModuleScript");

    const runCode = await client.request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_code",
        arguments: {
          sessionId: "session-1",
          code: "print('hello')"
        }
      }
    });
    assert.deepEqual(toolText(runCode.result), {
      ok: true,
      output: "ran"
    });

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/mcp/call",
        body: {
          name: "set_active_project",
          arguments: {
            projectId: "ExampleGame.project.json"
          }
        }
      },
      {
        method: "POST",
        url: "/mcp/call",
        body: {
          name: "connect_session",
          arguments: {
            projectId: "ExampleGame.project.json",
            placeId: 123
          }
        }
      },
      {
        method: "POST",
        url: "/mcp/call",
        body: {
          name: "get_tree",
          arguments: {
            sessionId: "session-1"
          }
        }
      },
      {
        method: "POST",
        url: "/mcp/call",
        body: {
          name: "inspect_instance",
          arguments: {
            sessionId: "session-1",
            path: "game.ServerScriptService.Hello"
          }
        }
      },
      {
        method: "POST",
        url: "/mcp/call",
        body: {
          name: "run_code",
          arguments: {
            sessionId: "session-1",
            code: "print('hello')"
          }
        }
      }
    ]);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
