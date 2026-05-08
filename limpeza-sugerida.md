# Limpeza sugerida do projeto

Gerado em 2026-05-07. Nada foi apagado; este arquivo e apenas uma lista de candidatos para limpeza.

## Pode apagar com seguranca

Estes itens sao artefatos gerados, logs locais ou saidas de build. Eles podem ser recriados pelos scripts do projeto.

- `dist/amarillo-vsix/`
- `dist/amarillo-vscode-1.0..vsix`
- `dist/amarillo-vscode-1.0.0.vsix`
- `dist/amarillo-vscode-1.0.1.vsix`
- `dist/amarillo-vscode-1.0.2.vsix`
- `dist/amarillo-vscode-1.0.3.vsix`
- `dist/amarillo-vscode-1.0.4.vsix`
- `dist/amarillo-vscode-1.0.5.vsix`
- `dist/amarillo-vscode-1.0.6.vsix`
- `dist/amarillo-vscode-1.0.7.vsix`
- `dist/amarillo-vscode-1.0.8.vsix`
- `dist/amarillo-vscode-1.0.9.vsix`
- `dist/amarillo-vscode-1.0.10.vsix`
- `dist/amarillo-vscode-1.0.11.vsix`
- `dist/amarillo-vscode-1.0.12.vsix`
- `dist/amarillo-vscode-1.0.13.vsix`
- `dist/amarillo-vscode-1.0.14.vsix`
- `dist/amarillo-vscode-1.0.15.vsix`
- `dist/amarillo-vscode-1.0.16.vsix`
- `dist/amarillo-vscode-1.0.17.vsix`
- `dist/amarillo-vscode-1.0.18.vsix`
- `dist/amarillo-vscode-1.0.19.vsix`
- `.amarillo/`
- `debug.log`
- `sourcemap.json`

Observacao: `dist/amarillo-vscode-1.0.20.vsix` e o pacote mais recente encontrado. Apague tambem se voce nao precisa instalar ou guardar esse build local.

## Pode apagar, mas sera recriado em uso normal

Estes arquivos sao configuracoes locais geradas para a maquina/workspace. Apague apenas se quiser forcar o Amarillo/VS Code a gerar de novo.

- `.pluginroblox.json`
- `.vscode/mcp.json`
- `.vscode/settings.json`

Nao apague `.vscode/tasks.json` nem `.vscode/extensions.json` sem revisar, porque eles parecem ser configuracoes intencionais do repo.

## Pode apagar para economizar espaco

Este item e pesado e totalmente regeneravel, mas exige reinstalar dependencias depois.

- `node_modules/`

Depois, reinstale com `npm.cmd ci`.

## JS gerado

No momento da varredura nao havia `.js` gerado fora de `dist/` e `node_modules/`, mas estes caminhos podem reaparecer depois de `npm run build`, `npm test` ou `npm run check`.

- `src/daemon/**/*.js`
- `src/mcp-proxy/**/*.js`
- `scripts/**/*.js`
- `tests/**/*.js`
- `vscode-extension/*.js`

Preferencia: use `npm.cmd run clean:generated` para remover esses JS gerados com seguranca.

## Nao apagar

Estes sao fontes ou arquivos importantes do projeto.

- `src/daemon/**/*.ts`
- `src/mcp-proxy/**/*.ts`
- `src/plugin/Amarillo.lua`
- `vscode-extension-src/`
- `scripts/*.ts`
- `tests/*.ts`
- `package.json`
- `package-lock.json`
- `amarillo-version.json`
- `README.md`
- `VsixGenerator.md`
- `.gitignore`
- `tsconfig*.json`
- `default.project.json`
- `examples/`

## Ordem recomendada

1. Apagar VSIX antigos em `dist/`, mantendo no maximo o ultimo pacote se voce ainda precisa instalar.
2. Apagar `dist/amarillo-vsix/`.
3. Apagar `.amarillo/`, `debug.log` e `sourcemap.json`.
4. Rodar `npm.cmd run clean:generated` depois de qualquer build/teste.
5. Apagar `node_modules/` somente se quiser recuperar espaco e estiver tranquilo para rodar `npm.cmd ci` depois.
