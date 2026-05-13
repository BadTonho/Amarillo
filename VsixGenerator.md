# Generate VSIX

Run this from the folder that contains the project, then enter the Amarillo repo:

```powershell
cd .\amarillo
```

Optional: set a new release version. This updates `amarillo-version.json`, root `package.json`, `package-lock.json`, the VS Code extension manifest, the daemon version, and the Roblox Studio plugin version together:

```powershell
npm.cmd run version:set -- 1.0.28
```

Then generate the VSIX:

```powershell
npm.cmd run package:vsix
```

`package:vsix` runs `version:sync` and `build` automatically. The TypeScript source in `src/daemon`, `src/mcp-proxy`, and `vscode-extension-src` is compiled before packaging, and the VSIX is written to `dist/`. The packaged runtime includes generated JavaScript only; the packager also fails if it finds local machine references such as `C:\Users\...`, editor extension paths, or `rbx-studio-mcp.exe`.

To install it locally:

```powershell
$version = (Get-Content .\amarillo-version.json | ConvertFrom-Json).extensionVersion
code.cmd --install-extension ".\dist\amarillo-vscode-$version.vsix" --force
```

Optional: remove generated JavaScript after packaging if you want the working tree back to TypeScript-only source files:

```powershell
npm.cmd run clean:generated
```
