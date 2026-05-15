"use strict";

const path = require("node:path");
const {
  repoRoot,
  sourcePathForGeneratedJavaScript,
  summarizeSources
} = require("./source-classifier");

function relative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function main() {
  const summary = summarizeSources(repoRoot);
  if (summary.generatedJavaScriptMissingSource.length > 0) {
    const details = summary.generatedJavaScriptMissingSource
      .map((filePath) => `${relative(filePath)} -> missing ${relative(sourcePathForGeneratedJavaScript(filePath) || filePath)}`)
      .join("\n");
    throw new Error(`Generated JavaScript without canonical TypeScript source:\n${details}`);
  }

  process.stdout.write(
    `[check-sources] ${summary.typescriptSource.length} TypeScript source file(s), ` +
    `${summary.generatedJavaScript.length} generated JavaScript file(s) ignored as source inventory.\n`
  );
}

main();
