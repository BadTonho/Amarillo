# Amarillo

Roblox Studio bridge inspired by Argon's architecture.

This repository contains the **source code for the bridge and the VS Code extension**. It should not be treated as the main Roblox workspace for a real game project.

## Components

- `src/daemon/` and `src/mcp-proxy/`: canonical TypeScript source for the HTTP daemon and MCP proxy. The generated `.js` files in these folders are build artifacts.
- `vscode-extension-src/`: canonical TypeScript source for the VS Code extension.
- `src/plugin/Amarillo.lua`: local Roblox Studio plugin; this remains Luau because Studio runs it directly.
- `src/daemon/**/*.js`, `src/mcp-proxy/**/*.js`, `vscode-extension/*.js`, `tests/*.js`, and `scripts/*.js`: generated JavaScript artifacts created by the TypeScript build.
- `tests/`: canonical TypeScript tests for project parsing, bootstrap, diagnostics, VSIX packaging, and MCP proxy behavior.

## Current Architecture

- A single authoritative daemon serves both the Studio plugin and the VS Code extension.
- The editor MCP does not start a second competing bridge.
- `Amarillo: Start Bridge` ensures the local bridge is running and writes or updates the portable workspace MCP files so the AI client can talk to the existing daemon through the `stdio -> HTTP` proxy.
- `Amarillo: Configure MCP for Workspace` and `Amarillo: Configure Codex MCP` regenerate the workspace MCP files and try to register the portable bootstrap with Codex CLI.
- The default port for the whole stack is `8323`.

## Recommended User Flow

1. Open your real Roblox workspace in VS Code.
2. Run `Amarillo: Install Roblox Studio Plugin`.
3. Run `Amarillo: Start Bridge`.
4. In Roblox Studio, open the `Amarillo` plugin and click `Connect`.
5. Use `Send Files to Studio`, `Receive Files from Studio`, and the MCP tools as needed.

## Place-Based Derived Projects

Amarillo supports a `base project + derived projects` model inside the same workspace:

- use `abstract: true` in a base `.project.json` to declare shared mounts and rules;
- use `extends` in place-specific projects so they inherit the base and only add exclusive folders;
- resolution stays automatic by `placeId`, so each Studio reconnection picks the correct derived project without requiring another VS Code window.

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

- Running `Amarillo: Start Bridge` also writes or updates `.vscode/mcp.json` and `.vscode/amarillo-mcp-bootstrap.cjs` in the open workspace.
- The machine-specific secret state is written to `.amarillo/mcp-local.json`; do not commit this file.
- If your AI or MCP client was already open, reopen the session so it reloads the workspace MCP servers.
- `Amarillo: Configure MCP for Workspace` and `Amarillo: Configure Codex MCP` try `codex mcp add amarillo -- node "<workspace>/.vscode/amarillo-mcp-bootstrap.cjs" --workspace "<workspace>"` automatically, and offer the same command to copy if Codex CLI is unavailable or registration fails.

Example requests for an AI client:

- `health`
- `list_projects`
- `get_tree`
- `run_code`
- `push_changes`
- `pull_changes`

## Recommended Development Flow For This Repo

Use the dedicated workspace in `examples/roblox-workspace/`.

The Node runtime and VS Code extension are authored from TypeScript sources:

- `src/daemon/**/*.ts` and `src/mcp-proxy/**/*.ts` compile to generated `.js` files in the same runtime folders
- `vscode-extension-src/` compiles to `vscode-extension/`
- `scripts/*.ts` compiles to `scripts/*.js`
- `tests/*.ts` compiles to `tests/*.js`

Run `npm run build` after editing runtime or extension TypeScript. Run `npm run build:scripts` before invoking generated script CLIs directly. Generated JavaScript stays in the existing runtime paths so Roblox Studio, tests, and VS Code packaging keep working, but it should not be edited or committed.

Useful commands:

- `npm.cmd run typecheck`: typechecks runtime, extension, contracts, scripts, and tests.
- `npm.cmd run check`: builds generated JavaScript and validates it with `node --check`.
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

## MCP

Available tools:

- read and sync: `health`, `list_projects`, `set_active_project`, `get_tree`, `get_selection`, `inspect_instance`, `run_code`, `push_changes`, `pull_changes`, `start_playtest`, `stop_playtest`
- introspection: `get_properties`, `get_descendants`, `search_instances`, `get_services`, `get_instance_info`, `get_output_log`
- destructive operations: `modify_property`, `create_instance`, `delete_instance`, `insert_model`

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
- destructive MCP operations can be blocked by session health or require explicit `Accept` / `Decline` in the Roblox plugin
- final validation for `push/pull`, `run_code`, and introspection still depends on a real connected Roblox Studio session

## Notes

- The project is still `Windows-first`.
- The Studio plugin remains a single file to make installation and reload simpler.
- Property sync is still extensible for new `className`s and serialized types.
- `syncback.ignoreNames`, `syncback.ignoreClasses`, and `syncback.ignoreProperties` are parsed, inherited, and enforced by the Studio-to-disk writer.
- Daily diagnostics live under `.amarillo/activity/YYYY-MM-DD/`, including file activity logs and dedicated MCP audit logs (`mcp.jsonl` and `mcp.md`).
