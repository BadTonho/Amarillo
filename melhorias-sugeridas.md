# Melhorias sugeridas

Atualizado em 2026-05-13 apos varredura completa do projeto Amarillo.

## Escopo da varredura

Foram revisados:

- runtime do daemon em `src/daemon`;
- proxy MCP em `src/mcp-proxy`;
- extensao VS Code em `vscode-extension-src`;
- plugin Roblox em `src/plugin/Amarillo.lua`;
- scripts de build, diagnostico, empacotamento e limpeza;
- testes em `tests`;
- configuracoes TypeScript, VSIX, Git ignore e documentacao.

## Validacoes executadas

- `npm.cmd run check`: passou. Inclui build de scripts/runtime/extensao/testes, typecheck completo e `node --check` nos JS gerados. Resultado: 48 arquivos JavaScript gerados passaram em sintaxe.
- `npm.cmd test`: passou. Resultado: 125 testes passaram, 0 falhas.
- Buscas estaticas com `rg`: rotas HTTP, tokens/autorizacao, comandos destrutivos, uso de `any`, `catch`, `fs.watch`, `rmSync`, logs JSONL, textos corrompidos, generated files, TODO/FIXME e pontos `OPT-*`.

Observacao: o PowerShell local continua emitindo aviso de Execution Policy ao carregar o profile do usuario. Isso apareceu nos comandos, mas nao foi classificado como erro do projeto.

## Estado do repositorio antes desta atualizacao

O repo ja tinha alteracoes pendentes antes desta varredura:

- `src/plugin/Amarillo.lua`
- `tests/extension-routes.test.ts`
- `tests/plugin-version.test.ts`
- `vscode-extension-src/extension.ts`
- `limpeza-sugerida.md` marcado como removido

Esta atualizacao mexe apenas neste arquivo.

## Resumo executivo

Nao encontrei falha quebrando build ou testes. Os riscos principais sao de robustez e compatibilidade:

1. configs JSON/TOML malformadas ainda podem derrubar o daemon em vez de virar diagnostico amigavel;
2. descoberta de projetos do daemon percorre diretorios demais e pode capturar `.project.json` em pastas geradas;
3. extensao VS Code assume sempre o primeiro workspace folder;
4. empacotamento VSIX e watcher do daemon continuam fortemente Windows-first;
5. ainda existem textos com encoding corrompido em strings visiveis;
6. consultas de logs leem e ordenam todo o historico a cada chamada;
7. tipagem ampla com `any` ainda limita a protecao real do TypeScript.

## Achados priorizados

### P1 - Configs malformadas podem derrubar o daemon

Arquivos/linhas:

- `src/daemon/project-resolver.ts:16`
- `src/daemon/project-resolver.ts:65`
- `src/daemon/project-resolver.ts:263`
- `src/daemon/app.ts:854`
- `src/daemon/project.ts:71`
- `src/daemon/project.ts:120`

Problema:

`readWorkspaceConfig()` e `createProjectDescriptor()` usam `JSON.parse` sem camada de recuperacao. Um `.pluginroblox.json` ou `.project.json` quebrado pode estourar no `refreshWorkspace()` e interromper o daemon, em vez de aparecer em `/doctor` ou `/errors`.

Sugestao:

- Criar leitura segura para configs e projetos.
- Registrar erro estruturado no `ErrorTracker`.
- Manter o daemon online com catalogo parcial quando possivel.
- Adicionar testes com `.pluginroblox.json` invalido e `.project.json` invalido.

### P1 - Textos com encoding corrompido chegam ao usuario

Arquivos/linhas:

- `vscode-extension-src/extension.ts:278`
- `vscode-extension-src/extension.ts:1329`
- `vscode-extension-src/extension.ts:1620`
- `scripts/diagnose.ps1:65`
- `src/daemon/lib/error-tracker.ts:7`
- `src/daemon/project.ts:625`
- `src/daemon/project.ts:640`

Problema:

Ha mojibake em comentarios e tambem em texto visivel, como tooltips da status bar e conversao Markdown -> RichText. O caso de `markdownToRichText()` troca bullets por uma sequencia corrompida dentro de `<b>...</b>`, o que pode vazar para conteudo sincronizado.

Sugestao:

- Normalizar esses textos para ASCII ou UTF-8 correto.
- Adicionar teste contra sequencias tipicas de mojibake em strings geradas/visiveis.
- Evitar simbolos especiais em PowerShell legado, ou salvar explicitamente em UTF-8 BOM quando necessario.

### P1 - Multi-root VS Code sempre usa a primeira pasta

Arquivos/linhas:

- `vscode-extension-src/extension.ts:129`
- `vscode-extension-src/extension.ts:137`
- `vscode-extension-src/extension.ts:321`

Problema:

`getWorkspaceFolder()` retorna `workspaceFolders[0]`. Em workspace multi-root, comandos podem iniciar o bridge, criar config, instalar MCP ou sincronizar sourcemap na pasta errada.

Sugestao:

- Resolver workspace pelo arquivo ativo quando houver editor.
- Caso haja multiplas pastas e nenhuma esteja ativa, pedir escolha via QuickPick.
- Guardar a pasta escolhida por workspace.
- Cobrir com teste de extensao simulando mais de um folder.

### P2 - Descoberta de projetos do daemon nao ignora todas as pastas geradas

Arquivos/linhas:

- `src/daemon/project-resolver.ts:74`
- `src/daemon/project.ts:129`
- `vscode-extension-src/extension.ts:199`

Problema:

A extensao ja ignora `.git`, `node_modules`, `.agent` e `dist`, com limite de profundidade. O daemon ignora apenas `.git`, `node_modules` e `.agent`. Isso deixa o daemon mais propenso a percorrer `.amarillo`, `.vscode`, `dist`, `build` ou fixtures grandes, e ate capturar `.project.json` gerado/temporario.

Sugestao:

- Centralizar a funcao de descoberta de `.project.json`.
- Alinhar ignores entre daemon e extensao.
- Considerar limite de profundidade ou allowlist baseada no workspace.
- Adicionar teste com `.project.json` dentro de `dist` ou `.amarillo`.

### P2 - `fs.watch(..., { recursive: true })` prende o daemon ao Windows/macOS

Arquivos/linhas:

- `src/daemon/app.ts:1128`
- `src/daemon/app.ts:1131`

Problema:

O projeto e Windows-first, mas `engines.node >=22` nao declara restricao de SO. Em Linux, `fs.watch` recursivo ainda pode falhar ou ter comportamento inconsistente dependendo do ambiente.

Sugestao:

- Documentar oficialmente o suporte Windows-first no runtime/VSIX.
- Tratar falha do watcher e cair para polling simples ou watchers por diretorio.
- Expor isso no Doctor quando o watcher nao puder iniciar.

### P2 - Empacotamento VSIX depende de PowerShell/Compress-Archive

Arquivos/linhas:

- `scripts/package-vsix.ts:110`
- `tests/package-vsix.test.ts:47`
- `tests/package-vsix.test.ts:48`

Problema:

O CLI de package chama PowerShell `Compress-Archive`. Isso funciona bem no alvo Windows, mas limita CI e empacotamento em Linux/macOS.

Sugestao:

- Manter o wrapper PowerShell, mas trocar o empacotador principal para uma lib Node de zip.
- Ou declarar explicitamente que `package:vsix` requer PowerShell.
- Adicionar teste/CI em Windows se a dependencia continuar.

### P2 - Consultas de activity/MCP audit leem todo o historico

Arquivos/linhas:

- `src/daemon/lib/activity-log.ts:114`
- `src/daemon/lib/activity-log.ts:180`
- `src/daemon/lib/activity-log.ts:202`
- `src/daemon/lib/mcp-audit-log.ts:88`
- `src/daemon/lib/mcp-audit-log.ts:150`
- `src/daemon/lib/mcp-audit-log.ts:172`
- `src/daemon/routes/diagnostics.ts:161`

Problema:

`query()` coleta todos os JSONL, faz parse de tudo e ordena todos os registros antes de aplicar `limit`. Conforme `.amarillo/activity` cresce, `/activity`, `/activity/summary` e o Doctor podem ficar lentos.

Sugestao:

- Ler dias mais recentes primeiro.
- Aplicar limite durante a leitura quando possivel.
- Manter um indice/resumo incremental por dia.
- Adicionar teste de performance com muitos arquivos diarios.

### P2 - Duplicacao de parser/config entre `project.ts` e `project-resolver.ts`

Arquivos/linhas:

- `src/daemon/project.ts:71`
- `src/daemon/project.ts:120`
- `src/daemon/project.ts:129`
- `src/daemon/project.ts:168`
- `src/daemon/project.ts:1485`
- `src/daemon/project-resolver.ts:16`
- `src/daemon/project-resolver.ts:65`
- `src/daemon/project-resolver.ts:74`
- `src/daemon/project-resolver.ts:263`

Problema:

`project.ts` ainda tem implementacoes antigas de parser TOML/config/projetos, mas no final exporta as funcoes do `project-resolver`. Isso aumenta o risco de divergencia e deixa mais dificil saber qual fluxo e canonico.

Sugestao:

- Remover funcoes antigas nao usadas ou mover tudo para um modulo unico.
- Garantir que imports externos usem somente `project-resolver` via uma API clara.
- Adicionar teste guardrail contra reintroducao de duplicatas.

### P3 - Parser TOML e propositalmente simples, mas isso limita compatibilidade

Arquivos/linhas:

- `src/daemon/project-resolver.ts:19`
- `src/daemon/project-resolver.ts:42`
- `src/daemon/project.ts:74`
- `src/daemon/project.ts:101`

Problema:

`parseSimpleToml()` suporta apenas `key = value` simples no topo do arquivo. Ele nao cobre TOML completo, secoes, strings com escapes, comentarios inline ou arrays complexos.

Sugestao:

- Documentar claramente o subconjunto aceito.
- Preferir `.pluginroblox.json` como config principal.
- Se compatibilidade Argon/Rojo for prioridade, adotar parser TOML real.

### P3 - Tipos amplos ainda escondem contratos importantes

Arquivos/linhas de exemplo:

- `src/daemon/app.ts:272`
- `src/daemon/app.ts:581`
- `vscode-extension-src/extension.ts:1363`
- `vscode-extension-src/extension.ts:1695`
- `src/daemon/mcp-tools.ts:376`

Problema:

O typecheck passa, mas varios fluxos centrais ainda usam `any`, inclusive app state, request/response payloads, provider da sidebar e schemas MCP. Isso reduz a chance de o TypeScript detectar regressao em payloads entre plugin, daemon, MCP e extensao.

Sugestao:

- Priorizar tipos para `PluginRobloxApp`, `Session`, `Project`, payloads de rotas e estado da sidebar.
- Trocar `requestJson(): Promise<any>` por generics nos chamadores principais.
- Expandir contratos em `src/daemon/contracts`.

### P3 - Rate limit e local clients compartilham a mesma chave

Arquivos/linhas:

- `src/daemon/lib/rate-limiter.ts:24`
- `src/daemon/app.ts:352`
- `src/daemon/app.ts:2730`

Problema:

O rate limiter usa `remoteAddress`. Studio plugin, VS Code, MCP proxy e chamadas manuais locais tendem a compartilhar `127.0.0.1`. Em bursts legitimos, todos competem pelo mesmo limite.

Sugestao:

- Considerar chave composta por origem/token/rota quando houver token valido.
- Aumentar tolerancia para rotas de long-poll e probes internos.
- Registrar diagnostico quando requests legitimos forem limitados.

## Itens que ja estao bons

- Build, typecheck e testes estao verdes.
- Rotas protegidas por bridge token e session token possuem cobertura.
- Operacoes destrutivas passam por gate de saude da sessao e confirmacao no plugin.
- `clean-generated` valida roots antes de apagar JS gerado.
- `package-vsix` valida referencias locais proibidas no payload.
- O healthcheck da extensao agora cobre rotas leves do daemon e MCP.

## Proxima ordem sugerida

1. Corrigir encoding visivel e adicionar teste de mojibake.
2. Tornar leitura de configs/projetos tolerante a JSON invalido, reportando no Doctor.
3. Alinhar descoberta de `.project.json` entre daemon e extensao.
4. Resolver multi-root na extensao.
5. Otimizar consultas de logs em `.amarillo/activity`.
6. Reduzir duplicacao entre `project.ts` e `project-resolver.ts`.
7. Refinar tipos centrais para diminuir `any`.
