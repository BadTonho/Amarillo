"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { PluginRobloxApp } = require("../../src/daemon/app");
const { readLocalProjectState } = require("../../src/daemon/project");
const { createTempDirectory, registerTestCleanup } = require("./test-temp");

const trackedApps = new Set<any>();

for (const methodName of ["refreshWorkspace", "start", "openSession"]) {
  const prototype = PluginRobloxApp.prototype;
  const originalMethod = prototype[methodName];
  if (typeof originalMethod !== "function" || originalMethod.__amarilloTestTracked) {
    continue;
  }
  const trackedMethod = function (...args) {
    trackedApps.add(this);
    return originalMethod.apply(this, args);
  };
  trackedMethod.__amarilloTestTracked = true;
  prototype[methodName] = trackedMethod;
}

registerTestCleanup(async () => {
  const apps = Array.from(trackedApps);
  trackedApps.clear();
  await Promise.all(apps.map(async (app) => {
    if (typeof app.stop === "function") {
      await app.stop();
    }
  }));
});

function createTempWorkspace() {
  return createTempDirectory("amarillo-daemon-");
}

function createWorkspaceWithProject() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "ServerScriptService"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "sync/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "return 1", "utf8");
  return workspace;
}

function createWorkspaceWithInheritedProjects() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "shared", "ServerScriptService"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "places", "Lobby", "ReplicatedStorage"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "places", "Dungeon", "ReplicatedStorage"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "shared", "ServerScriptService", "Common.server.luau"), "return 'shared'", "utf8");
  fs.writeFileSync(path.join(workspace, "places", "Lobby", "ReplicatedStorage", "Lobby.server.luau"), "return 'lobby'", "utf8");
  fs.writeFileSync(path.join(workspace, "places", "Dungeon", "ReplicatedStorage", "Dungeon.server.luau"), "return 'dungeon'", "utf8");
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    abstract: true,
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "shared/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Lobby.project.json"), JSON.stringify({
    name: "Lobby",
    extends: "Base.project.json",
    place_ids: [101],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "places/Lobby/ReplicatedStorage"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Dungeon.project.json"), JSON.stringify({
    name: "Dungeon",
    extends: "Base.project.json",
    place_ids: [202],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "places/Dungeon/ReplicatedStorage"
      }
    }
  }, null, 2));
  return workspace;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type InvokeOptions = {
  rawBody?: string;
  headers?: Record<string, string>;
};

type InvokeResult = {
  statusCode: number;
  headers: Record<string, string>;
  payload: any;
};

function seedStudioSnapshotFromLocalProject(app, session) {
  app.recordAppliedProjectSnapshot(
    session,
    readLocalProjectState(app.getProjectById(session.projectId)),
    "test_seed"
  );
}

function findSnapshotNodeByPath(snapshot, segments) {
  for (const mount of snapshot.mounts || []) {
    const mountSegments = mount.segments || [];
    if (!mountSegments.every((segment, index) => segments[index] === segment)) {
      continue;
    }
    let children = mount.children || [];
    let node = null;
    for (const segment of segments.slice(mountSegments.length)) {
      node = children.find((child) => child.name === segment) || null;
      if (!node) {
        return null;
      }
      children = node.children || [];
    }
    return node;
  }
  return null;
}

async function invoke(app, method, url, body?: any, options: InvokeOptions = {}): Promise<InvokeResult> {
  const request: any = options.rawBody !== undefined
    ? Readable.from([Buffer.from(options.rawBody, "utf8")])
    : (body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body), "utf8")]));
  request.method = method;
  request.url = url;
  request.headers = {
    host: "127.0.0.1:8323",
    ...(options.headers || {})
  };

  return new Promise<InvokeResult>((resolve, reject) => {
    let statusCode = 200;
    let responseHeaders: Record<string, string> = {};
    let responseBody = "";
    const response: any = {
      writeHead(code, headers = {}) {
        statusCode = code;
        responseHeaders = headers;
      },
      end(chunk = "") {
        responseBody += chunk;
        resolve({
          statusCode,
          headers: responseHeaders,
          payload: responseBody ? JSON.parse(responseBody) : {}
        });
      }
    };

    app.handleHttp(request, response).catch(reject);
  });
}

module.exports = {
  createTempWorkspace,
  createWorkspaceWithProject,
  createWorkspaceWithInheritedProjects,
  invoke,
  wait,
  seedStudioSnapshotFromLocalProject,
  findSnapshotNodeByPath
};
