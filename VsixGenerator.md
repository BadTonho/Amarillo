# Generate and install VSIX

This file is an operational checklist. Use it when creating a new Amarillo VSIX and installing it locally while keeping MCP portable across machines.

Before preparing a public release, review `PublicPluginDistributionPlan.md`. It documents the Roblox Studio plugin packaging work needed to avoid Luau `Out of local registers` failures in shared installs.

Run this from the folder that contains the workspace, then enter the Amarillo repo:

```powershell
cd .\amarillo
```

Optional: set a new release version. This updates `amarillo-version.json`, root `package.json`, `package-lock.json`, the VS Code extension manifest, the daemon version, and the Roblox Studio plugin version. Legacy direct-runtime `.vscode/mcp.json` files are updated best-effort, but the current MCP flow uses a portable bootstrap instead:

```powershell
npm.cmd run version:set -- 1.1.29
```

Generate the VSIX:

```powershell
npm.cmd run package:vsix
```

`package:vsix` runs `version:sync` and `build` automatically. `version:sync` updates the plugin source fragment in `src/plugin-src/`, and `build` regenerates the committed `src/plugin/Amarillo.lua` before packaging. The TypeScript source in `src/daemon`, `src/mcp-proxy`, and `vscode-extension-src` is compiled before packaging, and the VSIX is written to `dist/`. The packaged runtime includes generated JavaScript and the generated single-file Roblox plugin; the packager also fails if it finds local machine references such as `C:\Users\...`, editor extension paths, or `rbx-studio-mcp.exe`.

To install it locally:

```powershell
$version = (Get-Content .\amarillo-version.json | ConvertFrom-Json).extensionVersion
code.cmd --install-extension ".\dist\amarillo-vscode-$version.vsix" --force
```

After installing, reload VS Code so it loads the new extension folder:

```powershell
code.cmd --reuse-window .
```

Then run these VS Code commands from the Command Palette:

```text
Developer: Reload Window
Amarillo: Configure MCP for Workspace
Amarillo: Configure Codex MCP
Amarillo: Install Roblox Studio Plugin
Amarillo: Start Bridge
```

Important: `.vscode/mcp.json` should not point to your installed extension folder or the `.vsix` file. It should point to the workspace bootstrap:

```text
${workspaceFolder}/.vscode/amarillo-mcp-bootstrap.cjs
```

The bootstrap reads `.amarillo/mcp-local.json`, which is generated per machine and stores the installed extension path plus bridge token. Commit `.vscode/mcp.json` and `.vscode/amarillo-mcp-bootstrap.cjs` if this is a shared Roblox workspace; never commit `.amarillo/mcp-local.json`.

From the workspace root (`C:\Users\Admin\Desktop\amarillo`), verify the generated MCP config and tool discovery:

```powershell
cd ..
.\.agent\scripts\invoke-amarillo-mcp.cmd status
.\.agent\scripts\invoke-amarillo-mcp.cmd tools
.\.agent\scripts\invoke-amarillo-mcp.cmd describe health
```

Expected:

```text
hasMcpConfig: True
hasBridgeToken: True
toolCount: 22
```

If `status` cannot find the bridge token or local state, run `Amarillo: Configure MCP for Workspace`, `Amarillo: Configure Codex MCP`, or `Amarillo: Start Bridge`, then restart the AI/MCP session so it reloads `.vscode/mcp.json`.

To verify Codex CLI native registration specifically, run:

```powershell
codex mcp list
```

`Amarillo: Configure Codex MCP` tries to register the portable workspace bootstrap automatically. If the `amarillo` server is still not listed, register it manually:

```powershell
codex mcp add amarillo -- node ".\.vscode\amarillo-mcp-bootstrap.cjs" --workspace "."
```

This command should only point to the workspace bootstrap. Do not paste bridge tokens, `.amarillo/mcp-local.json` contents, or installed extension paths into shared config.

If Roblox Studio reports an older plugin version after the extension update, run `Amarillo: Install Roblox Studio Plugin`, then reload or reopen Roblox Studio.

Optional: remove generated JavaScript after packaging if you want the working tree back to TypeScript-only source files:

```powershell
npm.cmd run clean:generated
```

## Quick full flow

```powershell
cd .\amarillo
npm.cmd run version:set -- 1.0.31
npm.cmd run package:vsix
$version = (Get-Content .\amarillo-version.json | ConvertFrom-Json).extensionVersion
code.cmd --install-extension ".\dist\amarillo-vscode-$version.vsix" --force
cd ..
.\.agent\scripts\invoke-amarillo-mcp.cmd status
```

Then reload VS Code and run:

```text
Amarillo: Configure MCP for Workspace
Amarillo: Configure Codex MCP
Amarillo: Install Roblox Studio Plugin
Amarillo: Start Bridge
```
