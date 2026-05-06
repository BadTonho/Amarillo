"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("node:fs/promises");
const path = require("node:path");
const DEFAULT_PROJECT_DIRECTORIES = [
    path.join("src", "ReplicatedStorage"),
    path.join("src", "ServerScriptService"),
    path.join("src", "StarterPlayer", "StarterPlayerScripts"),
    path.join("src", "StarterGui"),
    path.join("src", "Workspace")
];
function workspaceProjectName(workspaceRoot) {
    return path.basename(path.resolve(workspaceRoot)) || "Game";
}
function buildDefaultProjectTemplate(workspaceRoot) {
    return {
        name: workspaceProjectName(workspaceRoot),
        tree: {
            $className: "DataModel",
            ReplicatedStorage: {
                $path: "src/ReplicatedStorage"
            },
            ServerScriptService: {
                $path: "src/ServerScriptService"
            },
            StarterPlayer: {
                StarterPlayerScripts: {
                    $path: "src/StarterPlayer/StarterPlayerScripts"
                }
            },
            StarterGui: {
                $path: "src/StarterGui"
            },
            Workspace: {
                $path: "src/Workspace"
            }
        }
    };
}
function buildDefaultProjectPath(workspaceRoot) {
    return path.join(workspaceRoot, `${workspaceProjectName(workspaceRoot)}.project.json`);
}
async function ensureWorkspaceProjectFile(workspaceRoot, collectProjectFiles) {
    const projectFiles = collectProjectFiles(workspaceRoot);
    if (projectFiles.length > 0) {
        return {
            created: false,
            projectFilePath: null,
            projectFiles
        };
    }
    const projectFilePath = buildDefaultProjectPath(workspaceRoot);
    const projectTemplate = buildDefaultProjectTemplate(workspaceRoot);
    await Promise.all(DEFAULT_PROJECT_DIRECTORIES.map((relativeDir) => fs.mkdir(path.join(workspaceRoot, relativeDir), { recursive: true })));
    await fs.writeFile(projectFilePath, `${JSON.stringify(projectTemplate, null, 2)}\n`, "utf8");
    return {
        created: true,
        projectFilePath,
        projectFiles: [projectFilePath]
    };
}
module.exports = {
    buildDefaultProjectPath,
    buildDefaultProjectTemplate,
    ensureWorkspaceProjectFile
};
