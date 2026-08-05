"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const registeredTempDirectories = new Set();
const registeredCleanupCallbacks = new Set<any>();
const FINAL_CLEANUP_DELAY_MS = 500;

function removeTempDirectory(directoryPath) {
  try {
    fs.rmSync(directoryPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
    return !fs.existsSync(directoryPath);
  } catch (error) {
    process.emitWarning(`Could not remove test temporary directory ${directoryPath}: ${error.message}`);
    return false;
  }
}

async function runRegisteredCleanupCallbacks() {
  for (const callback of registeredCleanupCallbacks) {
    try {
      await callback();
    } catch (error) {
      process.emitWarning(`Could not run test cleanup callback: ${error.message}`);
    }
  }
}

async function cleanupRegisteredTempDirectories() {
  await runRegisteredCleanupCallbacks();
  const directories = Array.from(registeredTempDirectories);
  for (const directoryPath of directories) {
    removeTempDirectory(directoryPath);
  }
}

function createTempDirectory(prefix = "amarillo-") {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registeredTempDirectories.add(directoryPath);
  return directoryPath;
}

function registerTempDirectory(directoryPath) {
  registeredTempDirectories.add(path.resolve(directoryPath));
  return directoryPath;
}

function registerTestCleanup(callback) {
  registeredCleanupCallbacks.add(callback);
  return callback;
}

test.afterEach(cleanupRegisteredTempDirectories);
test.after(async () => {
  await cleanupRegisteredTempDirectories();
  await new Promise((resolve) => setTimeout(resolve, FINAL_CLEANUP_DELAY_MS));
  await cleanupRegisteredTempDirectories();
  registeredTempDirectories.clear();
  registeredCleanupCallbacks.clear();
});

module.exports = {
  createTempDirectory,
  registerTempDirectory,
  registerTestCleanup,
  cleanupRegisteredTempDirectories
};
