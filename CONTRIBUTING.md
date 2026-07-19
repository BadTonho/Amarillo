# Contributing to Amarillo

## Prerequisites

- Node.js 22 or newer
- Roblox Studio for Studio/plugin validation
- Optional migration support: Rojo through Aftman, only when generating sourcemaps for an existing Rojo project. Amarillo sync itself does not require Rojo.

Install the Node dependencies once:

```powershell
npm ci
```

## Before submitting a change

Run the full local validation suite:

```powershell
npm run check
npm test
```

`npm run check` builds the runtime, extension, plugin, and tests; type-checks the TypeScript projects; verifies the source inventory; and checks generated JavaScript syntax.

Do not run `npm run package:vsix` unless the extension version has been updated intentionally. The package command regenerates the plugin and writes a VSIX artifact to `dist/`.

## Source layout

- `src/daemon/` — local HTTP daemon, MCP tools, project discovery, and sync coordination.
- `src/plugin-src/` — ordered Luau source modules for the Roblox Studio plugin.
- `src/plugin/Amarillo.lua` — generated plugin bundle; edit `plugin-src`, then rebuild.
- `vscode-extension-src/` — VS Code extension source.
- `tests/` — Node test suite and workspace helpers.
- `scripts/` — build, packaging, and validation utilities.

## Change guidelines

- Keep machine-local state out of Git. In particular, never commit `.amarillo/mcp-local.json`, `.pluginroblox.json`, `.env` files, or generated diagnostics.
- Add or update a focused test for behavior changes, especially around authentication, session state, and filesystem sync.
- Preserve the portable MCP configuration: shared config may reference the workspace bootstrap, but never a bridge token or installed extension path.
- Prefer small, isolated changes to daemon and plugin protocol behavior. When the protocol changes, update both sides and the relevant tests in the same change.

## Generated files

The following commands regenerate committed runtime artifacts as part of normal validation:

```powershell
npm run build
npm run build:tests
```

If a generated file changes after a source edit, include the matching generated output in the same commit. Use `npm run clean:generated` only when you explicitly want to remove ignored build output from the working tree.
