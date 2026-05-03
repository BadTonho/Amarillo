"use strict";

const { findNodeByPath, listTools } = require("./mcp-tools");
const { startStdioMcpServer, textContent } = require("./mcp-stdio");

function healthPayload(app) {
  return {
    workspaceRoot: app.workspaceRoot,
    projects: app.listProjects(),
    connectionOffer: app.connectionOfferSummary(),
    sessions: Array.from(app.sessions.values()).map((session) => app.sessionSummary(session))
  };
}

async function handleTool(app, name, args) {
  switch (name) {
    case "health":
      return textContent(healthPayload(app));

    case "list_projects":
      return textContent(app.listProjects());

    case "set_active_project":
      return textContent(await app.setActiveProject(args.projectId));

    case "get_tree":
      return textContent(await app.requestStudioTree(args.sessionId));

    case "get_selection":
      return textContent(await app.requestStudioSelection(args.sessionId));

    case "inspect_instance": {
      const snapshot = await app.requestStudioTree(args.sessionId);
      const node = findNodeByPath(snapshot, args.path);
      return textContent(node || { error: "Node not found." });
    }

    case "run_code":
      return textContent(await app.runStudioCode(args.sessionId, args.code));

    case "push_changes": {
      const snapshot = await app.requestStudioTree(args.sessionId);
      return textContent({
        ok: true,
        snapshot,
        snapshotHash: app.sessions.get(args.sessionId)?.lastStudioHash || null
      });
    }

    case "pull_changes": {
      const session = app.sessions.get(args.sessionId);
      const project = session ? app.getProjectById(session.projectId) : null;
      const result = await app.enqueueCommand(args.sessionId, "apply_project_tree", {
        project: project ? require("./project").readLocalProjectState(project) : null,
        reason: "mcp_pull"
      }, true);
      return textContent({ ok: true, result });
    }

    case "start_playtest":
      return textContent(await app.enqueueCommand(args.sessionId, "playtest", { mode: "start" }, true));

    case "stop_playtest":
      return textContent(await app.enqueueCommand(args.sessionId, "playtest", { mode: "stop" }, true));

    case "get_properties":
      return textContent(await app.enqueueCommand(args.sessionId, "get_properties", { path: args.path }, true));

    case "get_descendants":
      return textContent(await app.enqueueCommand(args.sessionId, "get_descendants", {
        path: args.path,
        maxDepth: Math.min(Math.max(Number(args.maxDepth) || 10, 1), 10),
        classFilter: args.classFilter || null
      }, true));

    case "search_instances":
      return textContent(await app.enqueueCommand(args.sessionId, "search_instances", {
        query: args.query,
        searchBy: args.searchBy || "both",
        scope: args.scope || null
      }, true));

    case "get_services":
      return textContent(await app.enqueueCommand(args.sessionId, "get_services", {}, true));

    case "get_instance_info":
      return textContent(await app.enqueueCommand(args.sessionId, "get_instance_info", { path: args.path }, true));

    case "get_output_log":
      return textContent(await app.enqueueCommand(args.sessionId, "get_output_log", {
        count: Math.min(Math.max(Number(args.count) || 50, 1), 200)
      }, true));

    case "modify_property":
      return textContent(await app.enqueueCommand(args.sessionId, "modify_property", {
        path: args.path,
        property: args.property,
        value: args.value
      }, true));

    case "create_instance":
      return textContent(await app.enqueueCommand(args.sessionId, "create_instance", {
        parentPath: args.parentPath,
        className: args.className,
        name: args.name || args.className,
        properties: args.properties || {}
      }, true));

    case "delete_instance":
      return textContent(await app.enqueueCommand(args.sessionId, "delete_instance", { path: args.path }, true));

    default:
      throw new Error(`Unsupported MCP tool: ${name}`);
  }
}

async function startMcpServer(app) {
  await startStdioMcpServer({
    serverInfo: {
      name: "amarillo-mcp",
      version: "0.1.0"
    },
    listTools,
    handleTool: (name, args) => handleTool(app, name, args)
  });
}

module.exports = {
  startMcpServer
};
