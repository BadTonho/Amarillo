# Changelog

## 1.1.41

- Adds **Dual-Hashing Protection** to compare both semantic and raw snapshot SHA-1 hashes, ensuring subtle default-valued GUI changes (like `ZIndex`) are correctly written to disk.
- Implements **Zero-Loss Mount Toggling** to remember and restore custom mount relative paths through disabled state metadata, preventing configuration loss when toggling sync.
- Introduces **Cross-Platform Relative Path Normalization** to automatically clean backslashes to forward slashes (`/`) for shared project configurations.
- Integrates the official **Amarillo Brand Icon** asset for the VS Code extension.

## 1.1.40

- Initializes the core VS Code extension architecture and robust local daemon infrastructure.

## 1.1.39

- Implements secure plugin bootstrapping, robust snapshot synchronization module, and core daemon versioning services.

## 1.1.38

- Streamlines daemon execution and introduces modular versioning and plugin infrastructure.
- Restructures the VS Code extension architecture and local bridge infrastructure.

## 1.1.36

- Modularizes the Roblox Studio plugin source into discrete, maintainable files.
- Implements highly optimized snapshot synchronization logic for the plugin.

## 1.1.34

- Implements **Sync Mount Validation** to prevent accidental data loss during destructive operations by validating targets before synchronization is applied.
- Enhances documentation and updates installation instructions for Amarillo bridge features.

## 1.1.32

- Introduces **Place Sync** diagnostics capability, exposing detailed status information via the diagnostics endpoint.

## 1.1.26

- Implements **Roblox Property Serialization** logic for advanced object translation between disk and Studio.
- Adds snapshot normalization and intelligent property defaulting logic for reliable verification of instance trees.
- Implements core plugin connection logic and status management for the Studio plugin.

## 1.1.25

- Adds **Workspace Sync Targets** functionality to manage and configure which parts of the workspace sync to Studio.
- Enhances script property handling for improved serialization.

## 1.1.23

- Enhances Roblox script classification in the `scriptFileKind` function with corresponding comprehensive unit tests.
- Refines extension and plugin versioning synchronization.

## 1.1.22

- Optimizes script classification logic to distinguish script kinds (Server, Client, Module) more accurately.

## 1.1.21

- Enhances model file handling and serialization within instance snapshots.

## 1.1.20

- Bumps version metadata and refines plugin-side workspace settings.

## 1.1.19

- Enhances project tree validation checks to prevent malformed schemas from reaching the bridge.

## 1.1.18

- Introduces a comprehensive **Synchronization Safety Plan** to prevent conflicting local and remote edits.

## 1.1.17

- Refines general Studio plugin functionality and diagnostics reporting.

## 1.1.16

- Upgrades version checks and synchronizes core package manifests.

## 1.1.15

- Encapsulates UI helper functions in the Roblox Studio plugin to reduce local register usage and prevent Luau stack limitations.

## 1.1.14

- Enhances instance snapshot handling and reconciliation algorithms in the plugin.

## 1.1.13

- Optimizes script document handling during rapid editor updates.

## 1.1.7

- Enhances plugin UI construction methods and layout components.
- Adds `placeName` support across connection and diagnostics interfaces.

## 1.1.5

- Implements the **Privileged Action Confirmation** feature to ask for explicit confirmation in Roblox Studio before executing potentially destructive actions or custom code.

## 1.1.4

- Integrates an event-driven file system watcher using `DescendantAdded` and `DescendantRemoving` for highly optimized performance.
- Introduces the versioning system and initial plugin-daemon handshake protocol.
- Adds helper utilities for daemon workspaces and modularizes the sidebar UI.

## 1.1.0

- Integrates **Codex MCP Configuration** commands for advanced AI coding support.
- Enhances workspace registration and command-line feedback for the Codex CLI integration.

## 1.0.38

- Enhances sidebar error handling and loading states.
- Filters out reserved Roblox attributes during active synchronization.
- Adds automated tests for sidebar rendering and Luau LSP sourcemap verification.
- Improves styling, layout, and visual presentation of the sidebar webview UI.

## 1.0.31

- Upgrades Codex MCP integration, workspace project discovery, and portable bootstrap script.
- Updates documentation and installation guide for easy user onboarding.

## 1.0.29

- Updates internal daemon packages and aligns dependency trees.

## 1.0.28

- Implements rate limiting on incoming HTTP endpoints to prevent spam.
- Refactors the VS Code extension healthcheck logic and optimizes status reporting tests.

## 1.0.16

- Implements the **Daemon Shielding System** to prevent connection hijacking and port competition.
- Improves MCP server configuration and stability.
- Solves synchronization loss that occurred when moving folders within VS Code.

## 1.0.9

- Forwards VS Code file create/delete/rename operations directly to the daemon so moving files in the VS Code Explorer stays synchronized.
- Keeps moved script sidecar metadata attached before the daemon applies the project tree to Studio.
- Updates the daemon's Studio snapshot cache after fast Studio source patches so Studio edits after a file move keep syncing.
- Reports plugin command failures during initial sync instead of letting the Studio plugin hang without a daemon response.

## 1.0.6

- Stores activity logs under `.amarillo/activity/YYYY-MM-DD/` instead of appending all days to one file.
- Stores error reports under `.amarillo/errors/YYYY-MM-DD/` while still reading legacy single-file logs.

## 1.0.5

- Updates the embedded Studio plugin when VSIX runtime content changes, regardless of file timestamps.
- Fixes move sync so Studio `Parent` changes are pushed back to disk and moved files do not duplicate in implicit folders.
- Repairs orphaned `*.meta.json` sidecars when scripts are moved in VS Code before applying the tree to Studio.

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
