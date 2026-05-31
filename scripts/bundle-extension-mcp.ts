"use strict";

const esbuild = require("esbuild");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(repoRoot, "vscode-extension-src", "mcp", "server.ts")],
    outfile: path.join(repoRoot, "vscode-extension", "mcp", "server.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: false,
    logLevel: "silent"
  });

  process.stdout.write("[bundle-extension-mcp] bundled vscode-extension/mcp/server.js\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
