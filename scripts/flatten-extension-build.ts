"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const buildSource = path.join(repoRoot, ".extension-build", "vscode-extension-src");
const extensionOutput = path.join(repoRoot, "vscode-extension");
const buildRoot = path.join(repoRoot, ".extension-build");

function copyJavaScriptFiles(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Extension build output not found: ${sourceDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyJavaScriptFiles(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) === ".js") {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

copyJavaScriptFiles(buildSource, extensionOutput);
fs.rmSync(buildRoot, { recursive: true, force: true });
