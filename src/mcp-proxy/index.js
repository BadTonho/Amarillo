"use strict";

const http = require("node:http");
const path = require("node:path");
const { readWorkspaceConfig } = require("../daemon/project");
const { findNodeByPath, listTools } = require("../daemon/mcp-tools");
const { startStdioMcpServer, textContent } = require("../daemon/mcp-stdio");

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    host: null,
    port: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace" && argv[index + 1]) {
      options.workspaceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--host" && argv[index + 1]) {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--port" && argv[index + 1]) {
      options.port = Number(argv[index + 1]);
      index += 1;
      continue;
    }
  }

  return options;
}

function resolveBridgeOptions(options) {
  const config = readWorkspaceConfig(options.workspaceRoot);
  return {
    workspaceRoot: options.workspaceRoot,
    host: options.host || config.argon.host || "127.0.0.1",
    port: Number(options.port || config.plugin.daemonPort || config.argon.port || 8323)
  };
}

// OPT-007: Persistent HTTP agent with keepAlive for reduced latency
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function requestJson(baseUrl, method, route, body, timeoutMs = 130000) {
  const url = new URL(route, `${baseUrl}/`);

  return new Promise((resolve, reject) => {
    const request = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      timeout: timeoutMs,
      agent: keepAliveAgent,
      headers: {
        "Content-Type": "application/json"
      }
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
          return;
        }

        try {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);

    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }

    request.end();
  });
}

function sessionRoute(sessionId, action, query = "") {
  const encodedSessionId = encodeURIComponent(String(sessionId));
  return `/session/${encodedSessionId}/${action}${query}`;
}

async function healthPayload(baseUrl) {
  const [health, projects] = await Promise.all([
    requestJson(baseUrl, "GET", "/health"),
    requestJson(baseUrl, "GET", "/projects")
  ]);

  return {
    workspaceRoot: health.workspaceRoot,
    projects: projects.projects || [],
    sessions: health.sessions || []
  };
}

async function callProxyTool(baseUrl, name, args) {
  switch (name) {
    case "health":
      return textContent(await healthPayload(baseUrl));

    case "list_projects": {
      const response = await requestJson(baseUrl, "GET", "/projects");
      return textContent(response.projects || []);
    }

    case "set_active_project": {
      const response = await requestJson(baseUrl, "POST", "/project/active", {
        projectId: args.projectId
      });
      return textContent(response.project);
    }

    case "get_tree": {
      const response = await requestJson(baseUrl, "GET", sessionRoute(args.sessionId, "tree"));
      return textContent(response.snapshot);
    }

    case "get_selection": {
      const response = await requestJson(baseUrl, "GET", sessionRoute(args.sessionId, "selection"));
      return textContent(response.selection || []);
    }

    case "inspect_instance": {
      const response = await requestJson(baseUrl, "GET", sessionRoute(args.sessionId, "tree"));
      const node = findNodeByPath(response.snapshot, args.path);
      return textContent(node || { error: "Node not found." });
    }

    case "run_code": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "exec"), {
        code: args.code
      });
      return textContent(response.result);
    }

    case "push_changes": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "push"), {});
      return textContent({
        ok: true,
        snapshot: response.snapshot,
        snapshotHash: response.snapshotHash || null
      });
    }

    case "pull_changes": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "pull"), {});
      return textContent({
        ok: true,
        result: response.result
      });
    }

    case "start_playtest": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "playtest"), {
        mode: "start"
      });
      return textContent(response.result);
    }

    case "stop_playtest": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "playtest"), {
        mode: "stop"
      });
      return textContent(response.result);
    }

    case "get_properties": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "properties"), {
        path: args.path
      });
      return textContent(response.result);
    }

    case "get_descendants": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "descendants"), {
        path: args.path,
        maxDepth: args.maxDepth,
        classFilter: args.classFilter
      });
      return textContent(response.result);
    }

    case "search_instances": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "search"), {
        query: args.query,
        searchBy: args.searchBy,
        scope: args.scope
      });
      return textContent(response.result);
    }

    case "get_services": {
      const response = await requestJson(baseUrl, "GET", sessionRoute(args.sessionId, "services"));
      return textContent(response.result);
    }

    case "get_instance_info": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "instance-info"), {
        path: args.path
      });
      return textContent(response.result);
    }

    case "get_output_log": {
      const count = Math.min(Math.max(Number(args.count) || 50, 1), 200);
      const response = await requestJson(baseUrl, "GET", sessionRoute(args.sessionId, "output-log", `?count=${count}`));
      return textContent(response.result);
    }

    case "modify_property": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "modify-property"), {
        path: args.path,
        property: args.property,
        value: args.value
      });
      return textContent(response.result);
    }

    case "create_instance": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "create-instance"), {
        parentPath: args.parentPath,
        className: args.className,
        name: args.name || args.className,
        properties: args.properties || {}
      });
      return textContent(response.result);
    }

    case "delete_instance": {
      const response = await requestJson(baseUrl, "POST", sessionRoute(args.sessionId, "delete-instance"), {
        path: args.path
      });
      return textContent(response.result);
    }

    default:
      throw new Error(`Unsupported MCP tool: ${name}`);
  }
}

async function main() {
  const options = resolveBridgeOptions(parseArgs(process.argv.slice(2)));
  const baseUrl = `http://${options.host}:${options.port}`;

  await startStdioMcpServer({
    serverInfo: {
      name: "amarillo-mcp-proxy",
      version: "0.1.0"
    },
    listTools,
    handleTool: (name, args) => callProxyTool(baseUrl, name, args)
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
