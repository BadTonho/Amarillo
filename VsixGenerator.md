# Generate and install VSIX

This file is an operational checklist. Use it when creating a new Amarillo VSIX and installing it locally without leaving MCP pointed at an old extension runtime.

Run this from the folder that contains the workspace, then enter the Amarillo repo:

```powershell
cd .\amarillo
```

Optional: set a new release version. This updates `amarillo-version.json`, root `package.json`, `package-lock.json`, the VS Code extension manifest, the daemon version, the Roblox Studio plugin version, and any existing workspace `.vscode/mcp.json` runtime path that points to an installed `amarillo-vscode-*` folder:

```powershell
npm.cmd run version:set -- 1.0.31
```

Generate the VSIX:

```powershell
npm.cmd run package:vsix
```

`package:vsix` runs `version:sync` and `build` automatically. The TypeScript source in `src/daemon`, `src/mcp-proxy`, and `vscode-extension-src` is compiled before packaging, and the VSIX is written to `dist/`. The packaged runtime includes generated JavaScript only; the packager also fails if it finds local machine references such as `C:\Users\...`, editor extension paths, or `rbx-studio-mcp.exe`.

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
Amarillo: Install Roblox Studio Plugin
Amarillo: Start Bridge
```

Important: `.vscode/mcp.json` points to the installed extension runtime folder, not to the `.vsix` file. After moving from one VSIX version to another, it must point to the new versioned path:

```text
C:\Users\Admin\.vscode\extensions\amarillo.amarillo-vscode-$version\runtime\mcp-proxy\index.js
```

From the workspace root (`C:\Users\Admin\Desktop\amarillo`), verify the generated MCP path and tool discovery:

```powershell
cd ..
.\.agent\scripts\invoke-amarillo-mcp.cmd status
.\.agent\scripts\invoke-amarillo-mcp.cmd tools
.\.agent\scripts\invoke-amarillo-mcp.cmd describe health
```

Expected:

```text
proxyExists: True
usesExpectedRuntime: True
toolCount: 22
```

If `status` still points to an old `amarillo-vscode-*` folder, run `npm.cmd run version:set -- <version>` again from `.\amarillo`, or run `Amarillo: Configure MCP for Workspace`, then restart the AI/MCP session so it reloads `.vscode/mcp.json`.

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
Amarillo: Install Roblox Studio Plugin
Amarillo: Start Bridge
```
