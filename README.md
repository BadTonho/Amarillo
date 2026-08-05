<div align="center">
  <img src="assets/icon.png" alt="Amarillo Logo" width="140" />

  # ⚡ Amarillo — Roblox Studio & VS Code Bridge

  **A modern, high-speed, and intelligent bidirectional bridge inspired by Argon's architecture.**
  *Engineered with TypeScript, Luau, and native MCP tooling for advanced AI and IDE workflows in Roblox Studio.*

  [![Release](https://img.shields.io/badge/OFFICIAL%20RELEASE-V1.2.0-00E599?style=for-the-badge&logo=github&logoColor=white)](https://github.com/)
  [![Node.js](https://img.shields.io/badge/RUNTIME-NODE%2022+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![TypeScript & Luau](https://img.shields.io/badge/LANGUAGE-TYPESCRIPT%20%26%20LUAU-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  <br />
  [![Roblox Studio](https://img.shields.io/badge/BRIDGE-ROBLOX%20STUDIO-00A2FF?style=for-the-badge&logo=roblox&logoColor=white)](https://create.roblox.com/)
  [![Platform](https://img.shields.io/badge/PLATFORM-WINDOWS%2010%20%7C%2011-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
  [![License: MIT](https://img.shields.io/badge/LICENSE-MIT-8A2BE2?style=for-the-badge&logo=open-source-initiative&logoColor=white)](LICENSE)

  <p align="center">
    <b>🇺🇸 English</b> | <a href="README.pt-BR.md">🇧🇷 Português (Brasil)</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.zh-CN.md">🇨🇳 简体中文</a>
  </p>
</div>
<br />

This repository contains the **source code for the bridge and the VS Code extension**. It should not be treated as the main Roblox workspace for a real game project.

## Components

- `src/daemon/` and `src/mcp-proxy/`: canonical TypeScript source for the HTTP daemon and MCP proxy with core services initialization. The generated `.js` files in these folders are build artifacts.
- `vscode-extension-src/`: canonical TypeScript source for the VS Code extension.
- `src/plugin-src/`: canonical ordered Luau fragments for the Roblox Studio plugin with comprehensive bootstrapping and status management.
- `src/plugin/Amarillo.lua`: generated, committed single-file Roblox Studio plugin consumed by Studio, the extension, and VSIX packaging.
- `src/daemon/**/*.js`, `src/mcp-proxy/**/*.js`, `vscode-extension/*.js`, `tests/*.js`, and `scripts/*.js`: generated JavaScript artifacts created by the TypeScript build.
- `tests/`: canonical TypeScript tests for project parsing, bootstrap, diagnostics, VSIX packaging, and MCP proxy behavior.

## Current Architecture

- A single authoritative daemon serves both the Studio plugin and the VS Code extension with comprehensive core services.
- The editor MCP does not start a second competing bridge.
- `Amarillo: Start Bridge` ensures the local bridge is running and writes or updates the portable workspace MCP files so the AI client can talk to the existing daemon through the `stdio -> HTTP` proxy.
- `Amarillo: Configure MCP for Workspace` and `Amarillo: Configure Codex MCP` regenerate the workspace MCP files and try to register the portable bootstrap with Codex CLI.
- Place-based synchronization with mount validation ensures safe destructive operations and maintains data integrity.
- Snapshot normalization and property defaulting provide reliable synchronization verification across different instance types.
- The default port for the whole stack is `8323`.

## Recommended User Flow

1. Open your real Roblox workspace in VS Code.
2. Run `Amarillo: Install Roblox Studio Plugin`.
3. Run `Amarillo: Start Bridge`.
4. In Roblox Studio, open the `Amarillo` plugin and click `Connect`.
5. Use `Send Files to Studio`, `Receive Files from Studio`, and the MCP tools as needed.

### Plugin Capabilities

The Amarillo plugin can:

**Core Functionality:**
- Bi-directional file synchronization between VS Code and Roblox Studio
- Real-time plugin connection status management and diagnostics
- Support for multi-place projects with automatic place detection by `placeId`

**Synchronization Features:**
- **Place Sync Monitoring**: Track and monitor synchronization status across multiple places
- **Sync Mount Validation**: Safe destructive operations with validation to prevent data loss
- **Workspace Sync Targets**: Manage and configure which parts of the workspace sync to Studio
- **Snapshot Normalization**: Automatic normalization of instance snapshots for consistent verification
- **Property Defaulting**: Intelligent property handling with proper Roblox property serialization
- **Dual-Hashing Protection**: Compares both a semantic hash and a raw snapshot SHA-1 hash to ensure even subtle default-valued GUI changes (like `ZIndex`) are written to disk
- **Zero-Loss Mount Toggling**: Remembers and restores custom mount relative paths through disabled state metadata, ensuring no configuration is lost when toggling sync
- **Path Traversal Protection**: Rejects unsafe path segments in source patching (e.g. `..` or subpath escapes) to maintain sandbox and directory integrity
- **Snapshot Path Sanitization**: Automatically escapes and sanitizes unsafe node names (such as `..\outside`) into safe filesystem filenames (like `__outside`), storing the original Roblox name in `init.meta.json`
- **Security-Hardened Local Daemon**: Enforces strict CORS preflight validation, only allowing local origins to prevent unauthorized web browsers from calling administrative or MCP API routes
- **JSON Payload Compression**: Automatically compresses high-traffic HTTP synchronization payloads using Brotli and Gzip to accelerate deep instance tree synchronization between disk and Roblox Studio
- **Intelligent Error Deduplication**: Enforces deduplication logic with structured event ID tracking to prevent repetitive Studio engine errors from flooding logs or stalling the daemon

**Diagnostics & Introspection:**
- Health checks and connection diagnostics
- Instance tree inspection and search
- Property examination and modification
- Script and instance classification analysis

**Advanced Operations:**
- Execute Luau code in Studio (with confirmation prompts for safety)
- Run playtests directly from VS Code
- Create, modify, and delete instances
- Insert models from the Roblox marketplace

## Place-Based Derived Projects

Amarillo supports a `base project + derived projects` model inside the same workspace with automatic place detection and synchronized targets:

- use `abstract: true` in a base `.project.json` to declare shared mounts and rules;
- use `extends` in place-specific projects so they inherit the base and only add exclusive folders;
- resolution stays automatic by `placeId`, so each Studio reconnection picks the correct derived project without requiring another VS Code window;
- each derived place can have its own sync targets configuration for fine-grained control over what gets synchronized.

Short example:

```json
{
  "name": "Base",
  "abstract": true,
  "tree": {
    "ReplicatedStorage": {
      "$path": "shared/ReplicatedStorage"
    }
  }
}
```

```json
{
  "name": "Lobby",
  "extends": "Base.project.json",
  "placeIds": [123456],
  "tree": {
    "ServerScriptService": {
      "$path": "places/Lobby/ServerScriptService"
    }
  }
}
```

With this layout, the shared folder is mounted into every derived place, while each exclusive folder only syncs inside its matching place.

## Using the MCP Tooling

The Amarillo plugin exposes a complete MCP (Model Context Protocol) interface for AI clients and external tools.

**Configuration & Setup:**
- Running `Amarillo: Start Bridge` also writes or updates `.vscode/mcp.json` and `.vscode/amarillo-mcp-bootstrap.cjs` in the open workspace.
- The machine-specific secret state is written to `.amarillo/mcp-local.json`; do not commit this file.
- If your AI or MCP client was already open, reopen the session so it reloads the workspace MCP servers.
- `Amarillo: Configure MCP for Workspace` and `Amarillo: Configure Codex MCP` try `codex mcp add amarillo -- node "<workspace>/.vscode/amarillo-mcp-bootstrap.cjs" --workspace "<workspace>"` automatically, and offer the same command to copy if Codex CLI is unavailable or registration fails.

**Available MCP Tools:**

*Synchronization & Core Operations:*
- `health` - Check bridge and plugin health status
- `list_projects` - List all available Roblox projects
- `set_active_project` - Switch the active project for synchronization
- `connect_session` - Create a new Studio session directly without requiring the offer/accept handshake
- `get_tree` - Get the current instance tree structure
- `get_selection` - Get currently selected instances in Studio
- `push_changes` - Send files from VS Code to Roblox Studio
- `pull_changes` - Receive files from Roblox Studio to VS Code
- `start_playtest` - Start a playtest session
- `stop_playtest` - Stop the active playtest

*Introspection & Diagnostics:*
- `inspect_instance` - Get detailed information about an instance
- `get_properties` - Retrieve all readable properties of an instance
- `get_descendants` - Get child instances with optional filtering
- `search_instances` - Search for instances by name or class name
- `get_services` - List available Roblox services
- `get_instance_info` - Get comprehensive instance information
- `get_output_log` - Retrieve recent Studio output log entries

*Privileged Operations (may require confirmation):*
- `run_code` - Execute Luau code in the Studio environment
- `modify_property` - Change an instance property or attribute
- `create_instance` - Create new instances
- `delete_instance` - Remove instances from the tree
- `insert_model` - Insert models from the Roblox marketplace

## Recommended Development Flow For This Repo

Use the dedicated workspace in `examples/roblox-workspace/`.

The Node runtime and VS Code extension are authored from TypeScript sources:

- `src/daemon/**/*.ts` and `src/mcp-proxy/**/*.ts` compile to generated `.js` files in the same runtime folders
- `vscode-extension-src/` compiles to `vscode-extension/`
- `scripts/*.ts` compiles to `scripts/*.js`
- `tests/*.ts` compiles to `tests/*.js`

The Roblox Studio plugin is authored from `src/plugin-src/*.lua` and generated into the committed single-file `src/plugin/Amarillo.lua`. Studio still loads the generated file directly; do not edit it by hand.

Run `npm run build` after editing runtime TypeScript, extension TypeScript, or plugin fragments. Run `npm run build:scripts` before invoking generated script CLIs directly. Generated JavaScript stays in the existing runtime paths so Roblox Studio, tests, and VS Code packaging keep working, but it should not be edited or committed.

Useful commands:

- `npm.cmd run typecheck`: typechecks runtime, extension, contracts, scripts, and tests.
- `npm.cmd run build:plugin`: regenerates `src/plugin/Amarillo.lua` from `src/plugin-src/manifest.json`.
- `npm.cmd run check`: builds generated JavaScript and validates it with `node --check`.
- `npm.cmd run check:sources`: verifies that generated JavaScript with a TypeScript counterpart is classified away from source inventories.
- `npm.cmd test`: builds all generated JavaScript required by tests, then runs `node --test`.
- `npm.cmd run diagnose:mcp -- --workspace .`: checks daemon reachability, MCP fallback auth headers, tools, and health probe.
- `npm.cmd run clean:generated`: removes ignored generated JavaScript from runtime, extension, scripts, and tests.

The root of this repository intentionally does not load a Rojo `.project.json`. To use Luau sourcemaps, validate Roblox sync, or test MCP as an end user, open `examples/roblox-workspace/` or the real Roblox workspace for your game.

If you use `aftman`, run `aftman install` at the repository root to install the `rojo` version declared in `aftman.toml`.

The tracked files in `.vscode/` point to that example workspace:

- `.vscode/tasks.json`
- `.vscode/extensions.json`

Local and generated files stay out of Git so we do not publish secrets, real workspace settings, or built artifacts:

- `.pluginroblox.json` is created per user; use `.pluginroblox.example.json` as a starting point when needed.
- `.vscode/mcp.json` and `.vscode/amarillo-mcp-bootstrap.cjs` are portable and can be committed with a shared workspace.
- `.amarillo/mcp-local.json` is generated per machine and stores the installed extension path plus bridge token.
- `.vscode/settings.json` is generated or managed locally by the extension.
- `sourcemap.json`, `debug.log`, `REPORT_*.md`, `dist/`, and `*.vsix` are build or diagnostic artifacts.

Available local tasks:

- `Amarillo Dev: Install Roblox Plugin`
- `Amarillo Dev: Start Example Daemon`
- `Amarillo Dev: Healthcheck Example`

## Tests

```powershell
node --test
```

## Generate VSIX

The extension package is not committed. Build it locally whenever you want to publish or install a package:

```powershell
npm run package:vsix
```

The final file will be created in `dist/`. Packaging includes only the generated JavaScript runtime and fails if a local machine reference such as `C:\Users\...`, editor extension paths, or `rbx-studio-mcp.exe` appears in the VSIX payload.

## Validated Status

- `node --test` should stay green
- the HTTP daemon responds on `127.0.0.1:8323`
- MCP responds to `initialize` and `tools/list`
- privileged MCP operations can be blocked by session health or require explicit `Accept` / `Decline` in the Roblox plugin
- final validation for `push/pull`, `run_code`, and introspection still depends on a real connected Roblox Studio session

## Notes

- The project is still `Windows-first`.
- The Studio plugin runtime remains a single generated file to make installation and reload simpler.
- Property sync is extensible for new `className`s and serialized types with proper Roblox property serialization.
- Synchronization includes snapshot normalization and property defaulting for reliable verification across instance types.
- Sync mount validation prevents accidental data loss during destructive operations by validating targets before sync.
- Dual-hashing change detection ensures precise disk-write skipping only when the snapshot raw contents are genuinely identical to the last synchronized state.
- Cross-platform relative path normalization automatically cleans backslashes to forward slashes (`/`) for shared project configurations, avoiding OS conflicts.
- `syncback.ignoreNames`, `syncback.ignoreClasses`, and `syncback.ignoreProperties` are parsed, inherited, and enforced by the Studio-to-disk writer.
- Daily diagnostics live under `.amarillo/activity/YYYY-MM-DD/`, including file activity logs and dedicated MCP audit logs (`mcp.jsonl` and `mcp.md`).
- Path traversal protection rejects unsafe path segments in source patching and sanitizes Roblox node names to safe filesystem representations, ensuring files outside authorized mounts are never overwritten.
- Strict CORS validation allows only local origins (`localhost`, `127.0.0.1`, etc.) to call the administrative API routes and MCP endpoints.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
