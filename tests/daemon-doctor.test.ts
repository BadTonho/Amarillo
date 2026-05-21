"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PluginRobloxApp } = require("../src/daemon/app");
const { readLocalProjectState } = require("../src/daemon/project");
const { AMARILLO_PROTOCOL_VERSION, CURRENT_PLUGIN_VERSION, MIN_PLUGIN_VERSION } = require("../src/daemon/version");
const {
  createTempWorkspace,
  createWorkspaceWithProject,
  createWorkspaceWithInheritedProjects,
  invoke,
  wait,
  seedStudioSnapshotFromLocalProject,
  findSnapshotNodeByPath
} = require("./helpers/daemon-workspace");


test("refreshWorkspace records invalid config and project diagnostics without throwing", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, ".pluginroblox.json"), "{ invalid", "utf8");
  fs.writeFileSync(path.join(workspace, "Broken.project.json"), "{ invalid", "utf8");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });

  assert.doesNotThrow(() => app.refreshWorkspace());
  assert.equal(app.projects.length, 0);

  const unresolved = app.errorTracker.query({ resolved: false });
  assert.ok(unresolved.some((entry) => entry.code === "PLUGIN_CONFIG_INVALID"));
  assert.ok(unresolved.some((entry) => entry.code === "PROJECT_JSON_INVALID"));

  const report = app.doctorReport();
  assert.equal(report.workspace.projectCount, 0);
  assert.ok(report.errors.recentUnresolved.some((entry) => entry.code === "PLUGIN_CONFIG_INVALID"));
  assert.ok(report.errors.recentUnresolved.some((entry) => entry.code === "PROJECT_JSON_INVALID"));
});

test("Doctor includes unresolved diagnostics and accepted Studio initial sync warnings", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const { session } = app.openSession(0, null, {
    connectionState: "accepted",
    truthSource: "studio",
    studioInstanceId: "studio-stuck",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    requirePluginVersion: true
  });
  app.recordError({
    component: "studio",
    severity: "error",
    code: "STUDIO-SNAPSHOT-AUTH",
    message: "Missing or invalid Studio session token.",
    sessionId: session.id,
    projectId: session.projectId,
    context: {
      route: "/studio/snapshot",
      statusCode: 401,
      reason: "initial_accept",
      hasSessionToken: false
    }
  });

  const report = app.doctorReport();
  assert.equal(report.summary.initialSyncStuckSessionCount, 1);
  assert.ok(report.summary.warnings.some((warning) => /initial Studio sync is still accepted/.test(warning)));
  assert.equal(report.errors.recentUnresolved.length, 1);
  assert.equal(report.errors.recentUnresolved[0].code, "STUDIO-SNAPSHOT-AUTH");
  assert.equal(report.sessions[0].connectionState, "accepted");
  assert.equal(report.sessions[0].lastCommandError, null);
});

test("reported plugin and extension errors are persisted through ErrorTracker", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const pluginResponse = await invoke(app, "POST", "/errors/add", {
    component: "plugin",
    severity: "error",
    code: "PLUGIN-TEST",
    message: "Plugin reported a test error"
  });
  const extensionResponse = await invoke(app, "POST", "/errors/add", {
    component: "extension",
    severity: "warning",
    code: "EXTENSION-TEST",
    message: "Extension reported a test warning"
  });

  assert.equal(pluginResponse.statusCode, 200);
  assert.equal(extensionResponse.statusCode, 200);
  const errors = await invoke(app, "GET", "/errors?limit=10");
  assert.equal(errors.payload.entries.some((entry) => entry.component === "plugin" && entry.code === "PLUGIN-TEST"), true);
  assert.equal(errors.payload.entries.some((entry) => entry.component === "extension" && entry.code === "EXTENSION-TEST"), true);
});

test("Doctor surfaces aggregated plugin safe-set failures as warnings", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "POST", "/errors/add", {
    component: "plugin",
    severity: "warning",
    code: "PLUGIN-SAFE-SET",
    message: "Safe-set failed during apply_project_tree: 2 failure(s) across 1 unique target/property/error combination(s).",
    sessionId: "session-1",
    projectId: "Game.project.json",
    context: {
      commandId: "cmd-1",
      commandType: "apply_project_tree",
      reason: "initial_pc_truth",
      totalFailures: 2,
      uniqueFailures: 1,
      failures: [{
        operation: "property",
        instance: "game.ServerScriptService.Hello",
        property: "Name",
        contextLabel: "sync rename",
        error: "Name is locked",
        count: 2,
        commandId: "cmd-1",
        commandType: "apply_project_tree",
        reason: "initial_pc_truth"
      }]
    }
  });

  assert.equal(response.statusCode, 200);
  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.statusCode, 200);
  assert.equal(doctor.payload.status, "warning");
  assert.equal(doctor.payload.summary.unresolvedErrorCount, 1);
  assert.match(doctor.payload.summary.warnings.join("\n"), /unresolved diagnostic error/);
  const safeSetError = doctor.payload.errors.recentUnresolved.find((entry) => entry.code === "PLUGIN-SAFE-SET");
  assert.ok(safeSetError);
  assert.equal(safeSetError.severity, "warning");
  assert.equal(safeSetError.context.totalFailures, 2);
  assert.equal(safeSetError.context.failures[0].property, "Name");
});

test("performance diagnostics expose daemon timing metrics and flow into Doctor", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  app.recordPerformance("test.metric.duration", 12.3456);
  app.recordPerformance("test.metric.duration", 3);

  const perf = await invoke(app, "GET", "/diagnostics/perf");
  assert.equal(perf.statusCode, 200);
  assert.equal(perf.payload.ok, true);
  assert.equal(perf.payload.metrics["test.metric.duration"].count, 2);
  assert.equal(perf.payload.metrics["test.metric.duration"].lastMs, 3);
  assert.equal(perf.payload.metrics["test.metric.duration"].maxMs, 12.346);

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.statusCode, 200);
  assert.equal(doctor.payload.performance["test.metric.duration"].count, 2);
});

test("MCP shield exposes HTTP fallback diagnostics and tool calls", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const status = await invoke(app, "GET", "/mcp/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.mcp.state, "fallback_ready");
  assert.equal(status.payload.mcp.config.status, "missing");
  assert.match(status.payload.mcp.fallback.callUrl, /\/mcp\/call$/);

  const tools = await invoke(app, "GET", "/mcp/tools");
  assert.equal(tools.statusCode, 200);
  assert.equal(tools.payload.ok, true);
  assert.ok(tools.payload.tools.some((tool) => tool.name === "health"));

  const probe = await invoke(app, "POST", "/mcp/probe", {});
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.payload.ok, true);
  assert.equal(probe.payload.parsed.workspaceRoot, workspace);
  assert.ok(app.mcpShield.lastProbeAt);

  const call = await invoke(app, "POST", "/mcp/call", {
    name: "list_projects",
    arguments: {}
  });
  assert.equal(call.statusCode, 200);
  assert.equal(call.payload.ok, true);
  assert.equal(call.payload.name, "list_projects");
  assert.equal(call.payload.parsed[0].name, "Game");
  assert.ok(app.mcpShield.lastHttpFallbackCallAt);
});

test("MCP shield reports ready when VS Code servers config is valid", async () => {
  const workspace = createWorkspaceWithProject();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const proxyEntry = path.join(workspace, "runtime", "mcp-proxy", "index.js");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          proxyEntry,
          "--workspace",
          workspace,
          "--host",
          "127.0.0.1",
          "--port",
          "8323"
        ]
      }
    }
  }, null, 2)}\n`, "utf8");

  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const status = await invoke(app, "GET", "/mcp/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.mcp.state, "ready");
  assert.equal(status.payload.mcp.config.status, "ready");

  const health = await invoke(app, "GET", "/health");
  assert.equal(health.payload.mcpShield.state, "ready");
});

test("MCP shield reports ready for portable bootstrap config with local state", async () => {
  const workspace = createWorkspaceWithProject();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const localStatePath = path.join(workspace, ".amarillo", "mcp-local.json");
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.mkdirSync(path.dirname(localStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(proxyEntry), { recursive: true });
  fs.writeFileSync(proxyEntry, "module.exports = {};\n", "utf8");
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        cwd: "${workspaceFolder}",
        args: [
          "${workspaceFolder}/.vscode/amarillo-mcp-bootstrap.cjs",
          "--workspace",
          "${workspaceFolder}"
        ]
      }
    }
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(localStatePath, `${JSON.stringify({
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token",
    extensionPath,
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");

  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const status = await invoke(app, "GET", "/mcp/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.mcp.state, "ready");
  assert.equal(status.payload.mcp.config.status, "ready");
  assert.equal(status.payload.mcp.config.server.hasBootstrapEntry, true);
  assert.equal(status.payload.mcp.config.localState.status, "ready");
  assert.doesNotMatch(JSON.stringify(status.payload.mcp.config), /secret-token/);
});

test("Doctor reports healthy workspace with compatible plugin and MCP config", async () => {
  const workspace = createWorkspaceWithProject();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          path.join(workspace, "runtime", "mcp-proxy", "index.js"),
          "--workspace",
          workspace,
          "--host",
          "127.0.0.1",
          "--port",
          "8323"
        ]
      }
    }
  }, null, 2)}\n`, "utf8");
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    extensionVersion: "1.0.16",
    extensionProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "studio",
    pluginVersion: CURRENT_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  const sessionId = accept.payload.session.id;
  await invoke(app, "POST", "/studio/snapshot", {
    sessionId,
    reason: "initial_accept",
    pluginVersion: CURRENT_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    snapshot: readLocalProjectState(app.getProjectById(accept.payload.session.projectId))
  }, {
    headers: {
      "x-amarillo-session-token": accept.payload.session.sessionToken
    }
  });
  await app.drainPendingStudioWrites();

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.statusCode, 200);
  assert.equal(doctor.payload.status, "ok");
  assert.equal(doctor.payload.versions.daemon.protocolVersion, AMARILLO_PROTOCOL_VERSION);
  assert.equal(doctor.payload.sessions[0].versionState, "compatible");
});

test("Doctor reports warning when MCP is only available through fallback", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  app.openSession(0, null);

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.payload.status, "warning");
  assert.match(doctor.payload.summary.warnings.join("\n"), /MCP/);
});

test("Doctor warns when privileged action confirmation is disabled", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  app.openSession(0, null, {
    connectionState: "ready",
    truthSource: "pc",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    requirePluginVersion: true,
    privilegedActionConfirmationEnabled: false
  });

  const doctor = await invoke(app, "GET", "/doctor");
  const warnings = doctor.payload.summary.warnings.join("\n");
  assert.equal(doctor.payload.status, "warning");
  assert.match(warnings, /privileged action confirmation is disabled/);
  assert.equal(doctor.payload.sessions[0].privilegedActionConfirmationEnabled, false);
  assert.equal(doctor.payload.sessions[0].privilegedActionsAllowed, true);
});

test("Doctor warns when a compatible Studio plugin is older than the bundled plugin", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  app.openSession(0, null, {
    connectionState: "ready",
    truthSource: "pc",
    studioInstanceId: "studio-outdated",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    requirePluginVersion: true,
    privilegedActionConfirmationEnabled: true
  });

  const doctor = await invoke(app, "GET", "/doctor");
  const warnings = doctor.payload.summary.warnings.join("\n");
  assert.equal(doctor.payload.status, "warning");
  assert.match(warnings, /Plugin update available/);
  assert.equal(doctor.payload.sessions[0].requiresPluginUpdate, false);
  assert.equal(doctor.payload.sessions[0].pluginUpdateAvailable, true);
  assert.equal(doctor.payload.sessions[0].currentPluginVersion, CURRENT_PLUGIN_VERSION);
});

test("Doctor reports blocked when sync is degraded", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  app.markSyncDegraded(session, "test degradation");
  const doctor = await invoke(app, "GET", "/doctor");

  assert.equal(doctor.payload.status, "blocked");
  assert.match(doctor.payload.summary.blockedReasons.join("\n"), /test degradation/);
});

test("Doctor reports blocked when a connected plugin needs an update", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc"
  });
  const doctor = await invoke(app, "GET", "/doctor");

  assert.equal(doctor.payload.status, "blocked");
  assert.match(doctor.payload.summary.blockedReasons.join("\n"), /Plugin update required/);
  assert.equal(doctor.payload.compatibility.blockedSessionIds.length, 1);
});

test("blocked destructive MCP calls are recorded in the MCP audit log and surfaced by Doctor", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date(Date.now() - 70000).toISOString();

  const response = await invoke(app, "POST", "/mcp/call", {
    name: "delete_instance",
    arguments: {
      sessionId: session.id,
      path: "game.Workspace.Part"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.parsed.ok, false);
  assert.equal(response.payload.parsed.blocked, true);
  assert.equal(response.payload.parsed.reasonCode, "STUDIO_CONTACT_CRITICAL");

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.payload.mcpAudit.total, 1);
  assert.equal(doctor.payload.mcpAudit.lastFailureOrDecline.reasonCode, "STUDIO_CONTACT_CRITICAL");
});

test("blocked run_code MCP calls are recorded in the MCP audit log and surfaced by Doctor", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date(Date.now() - 70000).toISOString();

  const response = await invoke(app, "POST", "/mcp/call", {
    name: "run_code",
    arguments: {
      sessionId: session.id,
      code: "return 'blocked'"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.parsed.ok, false);
  assert.equal(response.payload.parsed.blocked, true);
  assert.equal(response.payload.parsed.reasonCode, "STUDIO_CONTACT_CRITICAL");

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.payload.mcpAudit.total, 1);
  assert.equal(doctor.payload.mcpAudit.lastFailureOrDecline.tool, "run_code");
  assert.equal(doctor.payload.mcpAudit.lastFailureOrDecline.reasonCode, "STUDIO_CONTACT_CRITICAL");
});
