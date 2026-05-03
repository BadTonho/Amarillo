# Generate VSIX

Run this from the project root:

```powershell
cd .\amarillo
npm run package:vsix

```

The script reads the version from `vscode-extension/package.json` and generates the package in `dist/`.

To install it locally, adjust the file name to the generated version:

```powershell
code.cmd --install-extension .\dist\amarillo-vscode-0.5.2.vsix --force
```
