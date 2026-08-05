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

function renderGeneratedSidebarHtml(state) {
  const { renderSidebarHtml } = require(path.join(
    __dirname,
    "..",
    "vscode-extension",
    "sidebar-render.js"
  ));
  return renderSidebarHtml(state);
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

test("VS Code bridge start detects auth mismatches and never stops another workspace", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /bridgeAuthRequired/);
  assert.match(extensionSource, /authentication mode is incompatible/);
  assert.match(extensionSource, /\/bridge\/shutdown/);
  assert.match(extensionSource, /workspaceConflict/);
  assert.match(extensionSource, /Keeping the running bridge because it belongs to another workspace/);
  assert.match(extensionSource, /forceBridgeToken/);
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
  assert.match(extensionSource, /message\.type === "placeSyncApply"/);
  assert.match(extensionSource, /applyPlaceSyncFromSidebarMessage\(message\)/);
  assert.match(extensionSource, /placeId,\s+placeName,\s+baseMountIds,\s+exclusiveMountIds,\s+keepUnknowns/s);
  assert.match(extensionSource, /baseMountIds,\s+exclusiveMountIds,\s+keepUnknowns\s+\}, \{ timeout: 10000 \}\)/s);
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

test("sidebar renders inline Place Sync controls and apply message", () => {
  const html = renderGeneratedSidebarHtml({
    status: {
      title: "Bridge online",
      tone: "success",
      endpoint: "127.0.0.1:8323",
      workspace: "Game",
      notes: []
    },
    session: {
      title: "Studio Session",
      tone: "success",
      badge: "ready",
      message: "Ready.",
      facts: [],
      actions: []
    },
    placeSync: {
      enabled: true,
      mode: "edit",
      title: "Place Sync",
      description: "Choose shared and exclusive folders for the selected place project.",
      mountOptions: [
        { id: "ReplicatedStorage", label: "ReplicatedStorage", path: "ReplicatedStorage" },
        { id: "ServerScriptService", label: "ServerScriptService", path: "ServerScriptService" }
      ],
      selectedProjectId: "Arena.project.json",
      projects: [
        {
          id: "Arena.project.json",
          name: "Arena",
          label: "Arena - Place 123",
          baseMountIds: ["ReplicatedStorage"],
          exclusiveMountIds: ["ServerScriptService"],
          defaultBaseMountIds: ["ReplicatedStorage", "ServerScriptService"],
          defaultExclusiveMountIds: ["ReplicatedStorage", "ServerScriptService"],
          baseUseDefault: false,
          exclusiveUseDefault: false,
          keepUnknowns: true,
          mounts: [
            {
              id: "ReplicatedStorage",
              label: "ReplicatedStorage",
              baseRelativePath: "sync/ReplicatedStorage",
              exclusiveRelativePath: "places/Arena/ReplicatedStorage",
              baseEnabled: true,
              exclusiveEnabled: false
            },
            {
              id: "ServerScriptService",
              label: "ServerScriptService",
              baseRelativePath: "src/server",
              exclusiveRelativePath: "places/Arena/ServerScriptService",
              baseEnabled: false,
              exclusiveEnabled: true
            }
          ]
        }
      ]
    },
    sections: [],
    history: { entries: [] }
  });

  assert.match(html, /data-place-sync-form/);
  assert.match(html, /data-place-sync-mode="edit"/);
  assert.match(html, /data-place-sync-project/);
  assert.match(html, /data-place-sync-master="base"/);
  assert.match(html, /data-place-sync-master="exclusive"/);
  assert.match(html, /Sync shared sync\/src folders/);
  assert.match(html, /Sync exclusive place folders/);
  assert.match(html, /data-place-sync-list="base"/);
  assert.match(html, /data-place-sync-list="exclusive"/);
  assert.match(html, /data-place-sync-kind="base"/);
  assert.match(html, /data-place-sync-kind="exclusive"/);
  assert.match(html, /data-place-sync-mount="ReplicatedStorage"/);
  assert.match(html, /sync\/ReplicatedStorage/);
  assert.match(html, /src\/server/);
  assert.match(html, /places\/Arena\/ServerScriptService/);
  assert.match(html, /type: "placeSyncApply"/);
  assert.match(html, /placeSyncPayloadIds\(form, context, "base"\)/);
  assert.match(html, /placeSyncPayloadIds\(form, context, "exclusive"\)/);
  assert.match(html, /baseMountIds,\s+exclusiveMountIds,\s+keepUnknowns/s);
});

test("sidebar renders pending Place Sync create fields inline", () => {
  const html = renderGeneratedSidebarHtml({
    status: {
      title: "Bridge online",
      tone: "warning",
      endpoint: "127.0.0.1:8323",
      workspace: "Game",
      notes: []
    },
    session: {
      title: "Studio Session",
      tone: "warning",
      badge: "Place setup",
      message: "Setup required.",
      facts: [],
      actions: []
    },
    placeSync: {
      enabled: true,
      mode: "create",
      title: "Place Sync",
      description: "Setup Test Place (456).",
      mountOptions: [
        { id: "ReplicatedStorage", label: "ReplicatedStorage", path: "ReplicatedStorage" }
      ],
      create: {
        placeId: 456,
        placeName: "Test Place",
        sourceProjectLabel: "Base Project",
        baseMountIds: ["ReplicatedStorage"],
        exclusiveMountIds: ["ReplicatedStorage"],
        defaultBaseMountIds: ["ReplicatedStorage"],
        defaultExclusiveMountIds: ["ReplicatedStorage"],
        baseUseDefault: true,
        exclusiveUseDefault: true,
        keepUnknowns: true,
        mounts: [
          {
            id: "ReplicatedStorage",
            label: "ReplicatedStorage",
            baseRelativePath: "sync/ReplicatedStorage",
            exclusiveRelativePath: "places/Test/ReplicatedStorage",
            baseEnabled: true,
            exclusiveEnabled: true
          }
        ]
      },
      projects: []
    },
    sections: [],
    history: { entries: [] }
  });

  assert.match(html, /data-place-sync-mode="create"/);
  assert.match(html, /data-place-sync-place-name/);
  assert.match(html, /value="Test Place"/);
  assert.match(html, /data-place-sync-place-id/);
  assert.match(html, /value="456"/);
  assert.match(html, /Source: Base Project/);
  assert.match(html, /data-place-sync-master="base" checked/);
  assert.match(html, /data-place-sync-master="exclusive" checked/);
  assert.match(html, /data-place-sync-list="base" hidden/);
  assert.match(html, /data-place-sync-list="exclusive" hidden/);
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
