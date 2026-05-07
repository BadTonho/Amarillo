"use strict";

const path = require("node:path");
const { PluginRobloxApp } = require("./app");
const { startMcpServer } = require("./mcp");

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    host: null,
    port: null,
    mcp: true,
    autoSyncToStudio: undefined,
    extensionVersion: null,
    extensionProtocolVersion: null,
    bridgeToken: null,
    strictPort: false
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
    if (arg === "--extension-version" && argv[index + 1]) {
      options.extensionVersion = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--extension-protocol" && argv[index + 1]) {
      options.extensionProtocolVersion = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--bridge-token" && argv[index + 1]) {
      options.bridgeToken = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--strict-port") {
      options.strictPort = true;
      continue;
    }
    if (arg === "--no-mcp") {
      options.mcp = false;
      continue;
    }
    if (arg === "--auto-sync-to-studio") {
      options.autoSyncToStudio = true;
      continue;
    }
    if (arg === "--no-auto-sync-to-studio") {
      options.autoSyncToStudio = false;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const app = new PluginRobloxApp(options);

  process.on("SIGINT", async () => {
    await app.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await app.stop();
    process.exit(0);
  });

  await app.start();
  process.stderr.write(`[amarillo] daemon listening on http://${app.host}:${app.port} (workspace: ${app.workspaceRoot})\n`);

  if (options.mcp) {
    await startMcpServer(app);
  } else {
    await new Promise(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
