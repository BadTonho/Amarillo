# Changelog

## 0.4.9

- Adds a connection handshake between VS Code and Roblox Studio, with plugin-side approval and initial truth-source selection.
- Keeps continuous bidirectional sync after the initial connection.
- Ensures `.vscode/settings.json` for Luau LSP and creates `sourcemap.json` automatically when it is missing in the Roblox workspace.

## 0.4.8

- Makes `Configure MCP for Workspace` generate a `stdio -> HTTP` proxy instead of starting a second competing daemon.
- Shares the MCP tool definitions between the direct daemon and the proxy to avoid drift.
- Standardizes port fallbacks on `8323`.
- Moves the manual validation flow out of the repository root into `examples/roblox-workspace`.

## 0.4.5

- Makes `Start Bridge` fail early with a clear message when the current VS Code folder does not contain any `.project.json`.
- Makes the Roblox Studio plugin show `workspace has no project` when the current daemon points to a folder without a valid Roblox project.

## 0.4.4

- Makes the Roblox Studio plugin show the active workspace folder name instead of a fixed project name.
- Migrates the old default port `8123` to `8323` when the saved configuration still uses the legacy default.
- Keeps the VSIX aligned with the newer plugin version installed in Studio.

## 0.4.3

- Respects `daemonPort` from `.pluginroblox.json` when there is no VS Code override.
- Avoids showing the name of an external workspace in the sidebar when another daemon is using the same port.
- Removes old extension package metadata.

## 0.4.2

- Removes hardcoded references to old workspaces from local workspace configs.
- Makes the extension ignore sessions from a daemon serving another workspace on the same port.
- Shows the daemon's real workspace in the healthcheck and sidebar to make diagnostics easier.

## 0.4.1

- Fixes project resolution so exact `placeId` matches are preferred before fallback selection.
- Ignores `enabled: false` projects when building the list of available projects.
- Adds explicit project selection in the Roblox plugin `Settings` page for cases without `place_ids`.

## 0.4.0

- Removes redundant `activationEvents` from the extension manifest to clear VS Code warnings.
- Keeps the VS Code sidebar behavior the same, including sync and session selection.
- Redesigns the Roblox plugin with internal `Home`, `Settings`, and `Advanced` pages.

## 0.3.0

- Adds `Send Files to Studio` and `Receive Files from Studio` directly to the sidebar.
- Adds active Roblox Studio session selection through the extension.
- Shows the current session in the sidebar panel.

## 0.2.0

- Adds a dedicated icon to the VS Code activity bar.
- Adds an `Amarillo` panel with bridge status and quick actions.

## 0.1.0

- First version of the Amarillo VS Code extension pack.
- Installs the Roblox Studio plugin from VS Code.
- Controls the local bridge and generates `mcp.json`.
