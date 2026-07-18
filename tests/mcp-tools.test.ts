"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TOOL_DEFINITIONS, validateToolArguments } = require("../src/daemon/mcp-tools");

test("validateToolArguments rejects missing required arguments", () => {
  assert.throws(
    () => validateToolArguments("run_code", { sessionId: "session-1" }),
    /Missing required argument 'code'/
  );
});

test("validateToolArguments rejects invalid primitive types", () => {
  assert.throws(
    () => validateToolArguments("get_output_log", { sessionId: "session-1", count: "50" }),
    /Argument 'count'.*must be a number/
  );
});

test("validateToolArguments rejects enum values outside the schema", () => {
  assert.throws(
    () => validateToolArguments("search_instances", {
      sessionId: "session-1",
      query: "Part",
      searchBy: "assetId"
    }),
    /Argument 'searchBy'.*must be one of/
  );
});

test("validateToolArguments preserves valid argument objects", () => {
  const args = {
    sessionId: "session-1",
    parentPath: "game.Workspace",
    className: "Part",
    properties: {
      Anchored: true
    }
  };

  assert.equal(validateToolArguments("create_instance", args), args);
});

test("validateToolArguments enforces privileged payload and numeric bounds", () => {
  assert.throws(
    () => validateToolArguments("run_code", {
      sessionId: "session-1",
      code: "x".repeat(256 * 1024 + 1)
    }),
    /exceeds 262144 characters/
  );
  assert.throws(
    () => validateToolArguments("get_descendants", {
      sessionId: "session-1",
      path: "game.Workspace",
      maxDepth: 11
    }),
    /exceeds the maximum/
  );
});

test("run_code tool is documented as privileged", () => {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === "run_code");
  assert.ok(tool);
  assert.match(tool.description, /Privileged operation/);
});
