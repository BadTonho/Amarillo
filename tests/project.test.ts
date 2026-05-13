"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildNodeFromDirectory,
  loadWorkspaceProjectCatalog,
  loadWorkspaceProjects,
  moveOrphanScriptMetaForFile,
  parseProjectFile,
  patchStudioFileSource,
  readLocalProjectState,
  readWorkspaceConfig,
  resolveProjectSelectionForPlace,
  resolveProjectForPlace,
  writeStudioProjectState
} = require("../src/daemon/project");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-"));
}

test("parse argon config and project mounts", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "argon.toml"), 'host = "localhost"\nport = 8000\nchanges_threshold = 5\n');
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    place_ids: [1234],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "sync/ReplicatedStorage"
      },
      StarterPlayer: {
        StarterPlayerScripts: {
          $path: "sync/StarterPlayer/StarterPlayerScripts"
        }
      }
    }
  }, null, 2));

  const config = readWorkspaceConfig(workspace);
  assert.equal(config.argon.port, 8000);
  assert.equal(config.argon.changes_threshold, 5);

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  assert.deepEqual(project.placeIds, [1234]);
  assert.equal(project.mounts.length, 2);
  assert.equal(project.mounts[0].id, "ReplicatedStorage");
  assert.equal(project.mounts[1].id, "StarterPlayer.StarterPlayerScripts");
});

test("invalid plugin config returns empty plugin config with issue", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, ".pluginroblox.json"), "{ invalid", "utf8");

  const config = readWorkspaceConfig(workspace);

  assert.deepEqual(config.plugin, {});
  assert.equal(config.issues.length, 1);
  assert.equal(config.issues[0].code, "PLUGIN_CONFIG_INVALID");
  assert.equal(config.issues[0].projectId, null);
  assert.equal(config.issues[0].filePath, path.join(workspace, ".pluginroblox.json"));
});

test("project catalog ignores invalid project json while keeping valid projects", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Good.project.json"), JSON.stringify({
    name: "Good",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Workspace"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Broken.project.json"), "{ invalid", "utf8");

  const catalog = loadWorkspaceProjectCatalog(workspace);

  assert.deepEqual(catalog.selectableProjects.map((project) => project.name), ["Good"]);
  const invalidIssue = catalog.issues.find((issue) => issue.code === "PROJECT_JSON_INVALID");
  assert.ok(invalidIssue);
  assert.equal(invalidIssue.projectId, "Broken.project.json");
  assert.equal(invalidIssue.projectPath, "Broken.project.json");
  assert.equal(invalidIssue.filePath, path.join(workspace, "Broken.project.json"));
});

test("project catalog with only invalid project json stays empty and does not create default project", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Broken.project.json"), "{ invalid", "utf8");

  const catalog = loadWorkspaceProjectCatalog(workspace);

  assert.equal(catalog.projectFiles.length, 1);
  assert.equal(catalog.allProjects.length, 0);
  assert.equal(catalog.selectableProjects.length, 0);
  assert.ok(catalog.issues.some((issue) => issue.code === "PROJECT_JSON_INVALID"));
  assert.equal(fs.existsSync(path.join(workspace, "default.project.json")), false);
});

test("workspace discovery loads project files recursively", () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "nested"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "nested", "Test.project.json"), JSON.stringify({
    name: "Test",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Workspace"
      }
    }
  }));

  const projects = loadWorkspaceProjects(workspace);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, "nested/Test.project.json");
});

test("workspace discovery ignores generated and local project directories", () => {
  const workspace = createTempWorkspace();
  const ignoredDirs = [".git", "node_modules", ".agent", ".amarillo", ".vscode", "dist", "build"];
  const ignoredProject = {
    name: "Ignored",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Ignored"
      }
    }
  };
  const validProject = {
    name: "Live",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Workspace"
      }
    }
  };

  for (const ignoredDir of ignoredDirs) {
    fs.mkdirSync(path.join(workspace, ignoredDir), { recursive: true });
    fs.writeFileSync(path.join(workspace, ignoredDir, "Ignored.project.json"), JSON.stringify(ignoredProject, null, 2));
  }
  fs.mkdirSync(path.join(workspace, "valid"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "valid", "Live.project.json"), JSON.stringify(validProject, null, 2));

  const catalog = loadWorkspaceProjectCatalog(workspace);
  const relativeProjectFiles = catalog.projectFiles.map((projectPath) => path.relative(workspace, projectPath).replace(/\\/g, "/"));
  const issueText = JSON.stringify(catalog.issues);

  assert.deepEqual(relativeProjectFiles, ["valid/Live.project.json"]);
  assert.equal(catalog.allProjects.length, 1);
  assert.equal(catalog.selectableProjects.length, 1);
  assert.equal(catalog.allProjects[0].id, "valid/Live.project.json");
  assert.doesNotMatch(issueText, /Ignored\.project\.json/);
});

test("derived projects inherit mounts and filters from abstract bases", () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "bases", "shared", "ServerScriptService"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "places", "Lobby", "ReplicatedStorage"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "bases", "Base.project.json"), JSON.stringify({
    name: "Base",
    abstract: true,
    ignoreGlobs: ["**/*.skip.luau"],
    syncback: {
      ignoreNames: ["BaseOnly"]
    },
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "shared/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Lobby.project.json"), JSON.stringify({
    name: "Lobby",
    extends: "bases/Base.project.json",
    place_ids: [777],
    ignoreGlobs: ["**/*.tmp.luau"],
    syncback: {
      ignoreNames: ["LobbyOnly"]
    },
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "places/Lobby/ReplicatedStorage"
      }
    }
  }, null, 2));

  const catalog = loadWorkspaceProjectCatalog(workspace);
  const selectable = loadWorkspaceProjects(workspace);

  assert.equal(catalog.allProjects.length, 2);
  assert.equal(catalog.selectableProjects.length, 1);
  assert.equal(selectable.length, 1);
  assert.equal(selectable[0].name, "Lobby");
  assert.equal(selectable[0].extendsProjectId, "bases/Base.project.json");
  assert.deepEqual(selectable[0].placeIds, [777]);
  assert.deepEqual(selectable[0].ignoreGlobs, ["**/*.skip.luau", "**/*.tmp.luau"]);
  assert.deepEqual(selectable[0].syncback.ignoreNames, ["BaseOnly", "LobbyOnly"]);
  assert.deepEqual(
    selectable[0].mounts.map((mount) => mount.id).sort(),
    ["ReplicatedStorage", "ServerScriptService"]
  );
  assert.equal(
    selectable[0].mounts.find((mount) => mount.id === "ServerScriptService").absolutePath,
    path.join(workspace, "bases", "shared", "ServerScriptService")
  );
});

test("missing extends target invalidates only the dependent project", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Good.project.json"), JSON.stringify({
    name: "Good",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Workspace"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Broken.project.json"), JSON.stringify({
    name: "Broken",
    extends: "missing/Base.project.json",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Broken"
      }
    }
  }, null, 2));

  const catalog = loadWorkspaceProjectCatalog(workspace);

  assert.deepEqual(catalog.selectableProjects.map((project) => project.name), ["Good"]);
  assert.ok(catalog.issues.some((issue) => issue.code === "PROJECT_EXTENDS_NOT_FOUND"));
});

test("extends cycles are rejected without breaking unrelated projects", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Good.project.json"), JSON.stringify({
    name: "Good",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Workspace"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "A.project.json"), JSON.stringify({
    name: "A",
    extends: "B.project.json",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/A"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "B.project.json"), JSON.stringify({
    name: "B",
    extends: "A.project.json",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/B"
      }
    }
  }, null, 2));

  const catalog = loadWorkspaceProjectCatalog(workspace);

  assert.deepEqual(catalog.selectableProjects.map((project) => project.name), ["Good"]);
  assert.ok(catalog.issues.some((issue) => issue.code === "PROJECT_EXTENDS_CYCLE"));
});

test("project resolution prefers exact place match and ignores disabled projects", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Base"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Disabled.project.json"), JSON.stringify({
    name: "Disabled",
    enabled: false,
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Disabled"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Matched.project.json"), JSON.stringify({
    name: "Matched",
    place_ids: [999],
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Matched"
      }
    }
  }, null, 2));

  const projects = loadWorkspaceProjects(workspace);
  assert.equal(projects.length, 2);
  const selection = resolveProjectSelectionForPlace(projects, 999, "Base.project.json");
  assert.equal(selection.reason, "place_match");
  const resolved = resolveProjectForPlace(projects, 999, "Base.project.json");
  assert.equal(resolved.name, "Matched");
});

test("project resolution reports fallback when no place_id matches", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Base"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Mapped.project.json"), JSON.stringify({
    name: "Mapped",
    place_ids: [123],
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Mapped"
      }
    }
  }, null, 2));

  const projects = loadWorkspaceProjects(workspace);
  const selection = resolveProjectSelectionForPlace(projects, 555);
  assert.equal(selection.project.name, "Base");
  assert.equal(selection.reason, "no_place_filter");
  assert.match(selection.message, /555/);
});

test("project resolution never auto-selects abstract projects", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    abstract: true,
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Base"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Fallback.project.json"), JSON.stringify({
    name: "Fallback",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Fallback"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Mapped.project.json"), JSON.stringify({
    name: "Mapped",
    extends: "Base.project.json",
    place_ids: [321],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "sync/Mapped"
      }
    }
  }, null, 2));

  const catalog = loadWorkspaceProjectCatalog(workspace);
  const selection = resolveProjectSelectionForPlace(catalog.allProjects, 999, "Base.project.json");

  assert.equal(selection.project.name, "Fallback");
  assert.notEqual(selection.project.name, "Base");
});

test("local state roundtrip writes scripts and metadata", () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "ReplicatedStorage", "Shared"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "sync/ReplicatedStorage"
      }
    }
  }, null, 2));

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  writeStudioProjectState(project, {
    mounts: [
      {
        id: "ReplicatedStorage",
        children: [
          {
            name: "Shared",
            className: "Folder",
            properties: {},
            children: [
              {
                name: "Hello",
                className: "ModuleScript",
                fileKind: "module",
                ext: ".luau",
                source: "return 123",
                properties: {
                  Attributes: {
                    Demo: true
                  }
                },
                children: []
              }
            ]
          }
        ]
      }
    ]
  });

  const snapshot = readLocalProjectState(project);
  const mount = snapshot.mounts[0];
  assert.equal(mount.children[0].name, "Shared");
  assert.equal(mount.children[0].children[0].name, "Hello");
  assert.match(mount.children[0].children[0].source, /return 123/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(workspace, "sync", "ReplicatedStorage", "Shared", "Hello.meta.json"), "utf8")).properties.Attributes.Demo,
    true
  );
});

test("studio snapshot moves scripts between implicit folders on disk", () => {
  const workspace = createTempWorkspace();
  const syncRoot = path.join(workspace, "sync", "ServerScriptService");
  fs.mkdirSync(path.join(syncRoot, "OldFolder"), { recursive: true });
  fs.mkdirSync(path.join(syncRoot, "NewFolder"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "sync/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(syncRoot, "OldFolder", "Hello.server.luau"), "return 'old'", "utf8");

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  writeStudioProjectState(project, {
    mounts: [
      {
        id: "ServerScriptService",
        children: [
          {
            name: "OldFolder",
            className: "Folder",
            classNameSource: "defaultFolder",
            properties: {},
            children: []
          },
          {
            name: "NewFolder",
            className: "Folder",
            classNameSource: "defaultFolder",
            properties: {},
            children: [
              {
                name: "Hello",
                className: "Script",
                fileKind: "server",
                ext: ".server.luau",
                source: "return 'new'",
                properties: {},
                children: []
              }
            ]
          }
        ]
      }
    ]
  });

  assert.equal(fs.existsSync(path.join(syncRoot, "OldFolder", "Hello.server.luau")), false);
  assert.equal(fs.readFileSync(path.join(syncRoot, "NewFolder", "Hello.server.luau"), "utf8"), "return 'new'");
});

test("script moves repair orphaned sidecar metadata", () => {
  const workspace = createTempWorkspace();
  const syncRoot = path.join(workspace, "sync", "ServerScriptService");
  fs.mkdirSync(path.join(syncRoot, "OldFolder"), { recursive: true });
  fs.mkdirSync(path.join(syncRoot, "NewFolder"), { recursive: true });
  const oldMetaPath = path.join(syncRoot, "OldFolder", "Hello.meta.json");
  const newScriptPath = path.join(syncRoot, "NewFolder", "Hello.server.luau");
  fs.writeFileSync(oldMetaPath, JSON.stringify({
    properties: {
      Disabled: true
    }
  }, null, 2));
  fs.writeFileSync(newScriptPath, "return 1", "utf8");

  const result = moveOrphanScriptMetaForFile({ id: "ServerScriptService", absolutePath: syncRoot }, newScriptPath);

  assert.equal(result.moved, true);
  assert.equal(fs.existsSync(oldMetaPath), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(syncRoot, "NewFolder", "Hello.meta.json"), "utf8")).properties.Disabled,
    true
  );
});

test("project reads can repair existing orphaned sidecar metadata", () => {
  const workspace = createTempWorkspace();
  const syncRoot = path.join(workspace, "sync", "ServerScriptService");
  fs.mkdirSync(path.join(syncRoot, "OldFolder"), { recursive: true });
  fs.mkdirSync(path.join(syncRoot, "NewFolder"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "sync/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(syncRoot, "OldFolder", "Hello.meta.json"), JSON.stringify({
    properties: {
      Disabled: true
    }
  }, null, 2));
  fs.writeFileSync(path.join(syncRoot, "NewFolder", "Hello.server.luau"), "return 1", "utf8");

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  const snapshot = readLocalProjectState(project, { repairOrphanScriptMetas: true });
  const mount = snapshot.mounts[0];
  const newFolder = mount.children.find((child) => child.name === "NewFolder");
  const movedScript = newFolder.children.find((child) => child.name === "Hello");

  assert.equal(fs.existsSync(path.join(syncRoot, "OldFolder", "Hello.meta.json")), false);
  assert.equal(fs.existsSync(path.join(syncRoot, "NewFolder", "Hello.meta.json")), true);
  assert.equal(movedScript.properties.Disabled, true);
});

test("directory classNameSource separates implicit folders from explicit metadata", () => {
  const workspace = createTempWorkspace();
  const syncRoot = path.join(workspace, "sync", "ReplicatedStorage");
  fs.mkdirSync(path.join(syncRoot, "Implicit"), { recursive: true });
  fs.mkdirSync(path.join(syncRoot, "ExplicitGui"), { recursive: true });
  fs.mkdirSync(path.join(syncRoot, "ExplicitFolder"), { recursive: true });
  fs.writeFileSync(path.join(syncRoot, "ExplicitGui", "init.meta.json"), JSON.stringify({
    className: "ScreenGui"
  }, null, 2));
  fs.writeFileSync(path.join(syncRoot, "ExplicitFolder", "init.meta.json"), JSON.stringify({
    className: "Folder"
  }, null, 2));

  const implicit = buildNodeFromDirectory(path.join(syncRoot, "Implicit"));
  const explicitGui = buildNodeFromDirectory(path.join(syncRoot, "ExplicitGui"));
  const explicitFolder = buildNodeFromDirectory(path.join(syncRoot, "ExplicitFolder"));

  assert.equal(implicit.className, "Folder");
  assert.equal(implicit.classNameSource, "defaultFolder");
  assert.equal(explicitGui.className, "ScreenGui");
  assert.equal(explicitGui.classNameSource, "meta");
  assert.equal(explicitFolder.className, "Folder");
  assert.equal(explicitFolder.classNameSource, "meta");
});

test("studio snapshot writes metadata for non-Folder instance classes", () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "StarterGui"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      StarterGui: {
        $path: "sync/StarterGui"
      }
    }
  }, null, 2));

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  writeStudioProjectState(project, {
    mounts: [
      {
        id: "StarterGui",
        children: [
          {
            name: "DemoGui",
            className: "ScreenGui",
            classNameSource: "studio",
            properties: {},
            children: [
              {
                name: "Main",
                className: "Frame",
                classNameSource: "studio",
                properties: {},
                children: []
              },
              {
                name: "Stack",
                className: "UIListLayout",
                classNameSource: "studio",
                properties: {},
                children: []
              }
            ]
          }
        ]
      }
    ]
  });

  assert.equal(
    JSON.parse(fs.readFileSync(path.join(workspace, "sync", "StarterGui", "DemoGui", "init.meta.json"), "utf8")).className,
    "ScreenGui"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(workspace, "sync", "StarterGui", "DemoGui", "Main", "init.meta.json"), "utf8")).className,
    "Frame"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(workspace, "sync", "StarterGui", "DemoGui", "Stack", "init.meta.json"), "utf8")).className,
    "UIListLayout"
  );
});

test("patchStudioFileSource accepts array paths and game-prefixed string paths", () => {
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

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);

  const arrayResult = patchStudioFileSource(project, ["ServerScriptService", "Hello"], "return 2");
  assert.equal(arrayResult.ok, true);
  assert.match(fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "utf8"), /return 2/);

  const stringResult = patchStudioFileSource(project, "game.ServerScriptService.Hello", "return 3");
  assert.equal(stringResult.ok, true);
  assert.match(fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "utf8"), /return 3/);
});

test("syncback filters protect ignored Studio nodes and properties on disk", () => {
  const workspace = createTempWorkspace();
  const syncRoot = path.join(workspace, "sync", "ServerScriptService");
  fs.mkdirSync(path.join(syncRoot, "KeepByName"), { recursive: true });
  fs.mkdirSync(path.join(syncRoot, "KeepByClass"), { recursive: true });
  fs.writeFileSync(path.join(syncRoot, "KeepByName", "Old.server.luau"), "return 'name'", "utf8");
  fs.writeFileSync(path.join(syncRoot, "KeepByClass", "init.meta.json"), JSON.stringify({
    className: "ScreenGui"
  }, null, 2));
  fs.writeFileSync(path.join(syncRoot, "IgnoredByGlob.server.luau"), "return 'glob'", "utf8");
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    syncback: {
      ignoreGlobs: ["**/IgnoredByGlob.server.luau"],
      ignoreNames: ["KeepByName"],
      ignoreClasses: ["ScreenGui"],
      ignoreProperties: ["Disabled"]
    },
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "sync/ServerScriptService"
      }
    }
  }, null, 2));

  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  writeStudioProjectState(project, {
    mounts: [
      {
        id: "ServerScriptService",
        children: [
          {
            name: "KeepByName",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 'new name'",
            properties: {},
            children: []
          },
          {
            name: "KeepByClass",
            className: "ScreenGui",
            properties: {},
            children: []
          },
          {
            name: "IgnoredByGlob",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 'new glob'",
            properties: {},
            children: []
          },
          {
            name: "Normal",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 'ok'",
            properties: {
              Disabled: true,
              Attributes: {
                Synced: true
              }
            },
            children: []
          }
        ]
      }
    ]
  });

  assert.equal(fs.readFileSync(path.join(syncRoot, "KeepByName", "Old.server.luau"), "utf8"), "return 'name'");
  assert.equal(fs.existsSync(path.join(syncRoot, "KeepByName.server.luau")), false);
  assert.equal(fs.existsSync(path.join(syncRoot, "KeepByClass", "init.meta.json")), true);
  assert.equal(fs.readFileSync(path.join(syncRoot, "IgnoredByGlob.server.luau"), "utf8"), "return 'glob'");

  const normalMeta = JSON.parse(fs.readFileSync(path.join(syncRoot, "Normal.meta.json"), "utf8"));
  assert.equal(normalMeta.properties.Disabled, undefined);
  assert.equal(normalMeta.properties.Attributes.Synced, true);
});
