"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function readGeneratedExtensionFile(fileName) {
  return fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", fileName),
    "utf8"
  );
}

function readGeneratedExtensionBundle() {
  return [
    "extension.js",
    "sidebar.js",
    "sidebar-state.js",
    "sidebar-activity.js",
    "sidebar-styles.js",
    "sidebar-render.js",
    "bridge-state.js"
  ].map(readGeneratedExtensionFile).join("\n");
}

test("VS Code execute code command uses the daemon exec route", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /\/session\/\$\{session\.id\}\/exec/);
  assert.doesNotMatch(extensionSource, /\/session\/\$\{session\.id\}\/run-code/);
});

test("VS Code MCP healthcheck uses shield status and probe endpoints", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /\/mcp\/status/);
  assert.match(extensionSource, /\/mcp\/probe/);
  assert.match(extensionSource, /amarillo\.mcpHealthcheck/);
  assert.match(extensionSource, /inspectCodexMcpRegistration/);
  assert.match(extensionSource, /Codex MCP registration command/);
});

test("VS Code healthcheck reports Roblox Studio plugin status", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /describePluginHealth/);
  assert.match(extensionSource, /Healthcheck plugin:/);
  assert.match(extensionSource, /Plugin: no active Roblox Studio session is connected/);
  assert.match(extensionSource, /Plugin: connected to/);
});

test("VS Code healthcheck probes safe daemon routes", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /runHealthcheckRouteProbes/);
  assert.match(extensionSource, /\/doctor/);
  assert.match(extensionSource, /\/projects/);
  assert.match(extensionSource, /\/studio\/poll/);
  assert.match(extensionSource, /\/debug\/sync-state/);
  assert.match(extensionSource, /\/activity\/summary/);
  assert.match(extensionSource, /\/errors\/summary/);
  assert.match(extensionSource, /\/mcp\/tools/);
  assert.match(extensionSource, /\/mcp\/probe/);
  assert.match(extensionSource, /Healthcheck routes:/);
});

test("VS Code Doctor command calls /doctor and daemon receives extension protocol args", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /\/doctor/);
  assert.match(extensionSource, /amarillo\.doctor/);
  assert.match(extensionSource, /--extension-version/);
  assert.match(extensionSource, /--extension-protocol/);
  assert.match(extensionSource, /--bridge-token/);
  assert.match(extensionSource, /--strict-port/);
  assert.match(extensionSource, /X-Amarillo-Bridge-Token/);
  assert.match(extensionSource, /Recent unresolved diagnostic errors/);
  assert.match(extensionSource, /lastCommandError/);
  assert.match(extensionSource, /initial Studio sync is still accepted/);
  assert.match(extensionSource, /Codex MCP:/);
  assert.match(extensionSource, /Register native Codex MCP manually/);
});

test("sidebar source models fallback-only, plugin stale, version mismatch, and sync paused alerts", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /Native MCP not detected\. HTTP fallback is available/);
  assert.match(extensionSource, /Plugin stale/);
  assert.match(extensionSource, /Contact delayed/);
  assert.match(extensionSource, /Plugin update required/);
  assert.match(extensionSource, /Plugin update available/);
  assert.match(extensionSource, /sync paused/);
  assert.match(extensionSource, /Destructive MCP actions are blocked/);
});

test("sidebar renders loading and error fallbacks instead of a blank webview", () => {
  const extensionSource = readGeneratedExtensionBundle();

  assert.match(extensionSource, /buildSidebarLoadingState/);
  assert.match(extensionSource, /Loading Amarillo/);
  assert.match(extensionSource, /buildSidebarErrorState/);
  assert.match(extensionSource, /Sidebar needs attention/);
  assert.match(extensionSource, /renderSidebarFatalHtml/);
  assert.match(extensionSource, /withSidebarTimeout/);
  assert.match(extensionSource, /timed out after/);
  assert.match(extensionSource, /SIDEBAR_HEALTH_TIMEOUT_MS = 1200/);
  assert.match(extensionSource, /SIDEBAR_STATE_TIMEOUT_MS = 4500/);
  assert.match(extensionSource, /fetchDaemonHealth\(\{ timeout: SIDEBAR_HEALTH_TIMEOUT_MS \}\)/);
  assert.match(extensionSource, /Bridge health check failed:/);
  assert.match(extensionSource, /Bridge offline/);
  assert.match(extensionSource, /Sidebar refresh failed after/);
  assert.match(extensionSource, /this\.view\.webview\.html = renderSidebarHtml\(buildSidebarLoadingState\(\)\)/);
  assert.match(extensionSource, /refreshThenHandleVisible/);
  assert.match(extensionSource, /handleSidebarVisible\(this\.context, runtimeState\)/);
});

test("sidebar exposes Auto Sync toggle and visual sync history actions", () => {
  const extensionSource = readGeneratedExtensionBundle();
  const packageJson = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "package.json"),
    "utf8"
  );

  assert.match(extensionSource, /amarillo\.toggleAutoSyncToStudio/);
  assert.match(extensionSource, /amarillo\.togglePrivilegedActionConfirmation/);
  assert.match(extensionSource, /amarillo\.configurePlaceSync/);
  assert.match(extensionSource, /amarillo\.createPlaceProject/);
  assert.match(extensionSource, /amarillo\.editPlaceIds/);
  assert.match(extensionSource, /\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/place-sync/);
  assert.match(extensionSource, /\/settings\/auto-sync-to-studio/);
  assert.match(extensionSource, /\/settings\/privileged-action-confirmation/);
  assert.match(extensionSource, /\/projects\/place-setup/);
  assert.match(extensionSource, /\/projects\/\$\{encodeURIComponent\(picked\.project\.id\)\}\/place-ids/);
  assert.match(extensionSource, /exclusiveMountIds/);
  assert.match(extensionSource, /baseMountIds/);
  assert.match(extensionSource, /Auto Sync: On/);
  assert.match(extensionSource, /Auto Sync: Off/);
  assert.match(extensionSource, /Confirm Actions: On/);
  assert.match(extensionSource, /Confirm Actions: Off/);
  assert.match(extensionSource, /title: "Places"/);
  assert.match(extensionSource, /Configure Place Sync/);
  assert.match(extensionSource, /Create Place Project/);
  assert.match(extensionSource, /Edit Place IDs/);
  assert.match(extensionSource, /Sync History/);
  assert.match(extensionSource, /\/activity\?limit=\$\{encodeURIComponent\(String\(limit\)\)\}&includeDetails=true/);
  assert.match(extensionSource, /data-activity-action="openDiff"/);
  assert.match(extensionSource, /data-activity-action="revert"/);
  assert.match(extensionSource, /amarillo-activity/);
  assert.match(extensionSource, /vscode\.diff/);
  assert.match(packageJson, /amarillo\.toggleAutoSyncToStudio/);
  assert.match(packageJson, /amarillo\.togglePrivilegedActionConfirmation/);
  assert.match(packageJson, /amarillo\.configurePlaceSync/);
  assert.match(packageJson, /amarillo\.createPlaceProject/);
  assert.match(packageJson, /amarillo\.editPlaceIds/);
  assert.match(packageJson, /amarillo\.privilegedActionConfirmation/);
});

test("activation sourcemap check is delayed and respects autoGenerateSourcemap", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /SOURCEMAP_ACTIVATION_DELAY_MS = 3000/);
  assert.match(extensionSource, /scheduleExistingWorkspaceSourcemapOnActivate/);
  assert.match(extensionSource, /autoGenerateSourcemap/);
  assert.match(extensionSource, /Skipping activation sourcemap check because amarillo\.autoGenerateSourcemap is disabled/);
  assert.match(extensionSource, /Scheduling activation sourcemap check in/);
  assert.match(extensionSource, /setTimeout\(\(\) =>/);
  assert.doesNotMatch(extensionSource, /log\("Amarillo extension activated\."\);\s*void ensureExistingWorkspaceSourcemapOnActivate\(\);/);
});

test("sidebar visual status tones and compact layout rules are present", () => {
  const extensionSource = readGeneratedExtensionBundle();

  for (const tone of ["success", "warning", "danger", "info", "neutral"]) {
    assert.match(extensionSource, new RegExp(`tone-${tone}`));
    assert.match(extensionSource, new RegExp(`tone-border-${tone}`));
  }
  assert.match(extensionSource, /--tone-success-bg/);
  assert.match(extensionSource, /--tone-warning-bg/);
  assert.match(extensionSource, /--tone-danger-bg/);
  assert.match(extensionSource, /text-align: center/);
  assert.match(extensionSource, /border-radius: 8px/);
  assert.doesNotMatch(extensionSource, /color-mix/);
});
