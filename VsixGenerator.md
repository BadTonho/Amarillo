# Generate VSIX

Run this from the folder that contains the project, then enter the project root:

```powershell
cd .\amarillo
```

To set a new release version, run this once. It updates `amarillo-version.json`, the VS Code extension manifest, the daemon version, and the Roblox Studio plugin version together:

```powershell
npm.cmd run version:set -- 1.0.18
```

Then generate the VSIX:

```powershell
npm.cmd run package:vsix
```

`package:vsix` runs `version:sync` automatically before building, so the generated package uses the version from `amarillo-version.json` and writes the file to `dist/`.

To install it locally:

```powershell
$version = (Get-Content .\amarillo-version.json | ConvertFrom-Json).extensionVersion
code.cmd --install-extension ".\dist\amarillo-vscode-$version.vsix" --force
```
