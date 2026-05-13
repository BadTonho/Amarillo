# Melhorias sugeridas

Atualizado em 2026-05-13 apos nova varredura completa do projeto Amarillo.

## Escopo da varredura

Foram revisados:

- runtime do daemon em `src/daemon`;
- proxy MCP em `src/mcp-proxy`;
- extensao VS Code em `vscode-extension-src`;
- plugin Roblox em `src/plugin/Amarillo.lua`;
- scripts de build, diagnostico, empacotamento e limpeza;
- testes em `tests`;
- configuracoes TypeScript, VSIX, Git ignore e documentacao (`README.md`, `VsixGenerator.md` e notas MCP).

## Validacoes executadas

- `npm.cmd run check`: passou. Inclui build de scripts/runtime/extensao/testes, typecheck completo e `node --check` nos JS gerados. Resultado final: `56 JavaScript files passed node --check`.
- `npm.cmd test`: passou. Resultado final: `149 tests`, `149 pass`, `0 fail`.
- `npm.cmd audit --omit=dev`: passou. Resultado: `found 0 vulnerabilities`.
- `npm.cmd audit`: passou com permissao normal de cache/rede. Resultado: `found 0 vulnerabilities`.
- `npm.cmd run package:vsix`: passou. Resultado: VSIX gerado em `dist/amarillo-vscode-1.0.32.vsix`.
- `git status --short` com `safe.directory` temporario: alteracoes esperadas das implementacoes P1/P2/P3 em docs, testes, daemon e fontes da extensao.
- Buscas estaticas com `rg`: configs, parsers, watchers, logs JSONL, rate limiter, `any`, PowerShell, MCP, project discovery, operacoes destrutivas e pontos `OPT-*`.

Observacao: o PowerShell local continua emitindo aviso de Execution Policy ao tentar carregar o profile do usuario. Isso apareceu nos comandos, mas nao foi classificado como erro do projeto.

## Resumo executivo

Nao encontrei falha quebrando build, testes, auditoria de dependencias ou empacotamento VSIX. O estado atual esta bem melhor que a varredura anterior: configs invalidas, mojibake visivel e multi-root ja possuem cobertura verde.

Os riscos principais restantes sao de robustez, portabilidade e escala:

1. consultas de activity/MCP audit leem e ordenam todo o historico;
2. `fs.watch(..., { recursive: true })` e o empacotador VSIX seguem Windows-first;
3. o rate limiter agrupa todos os clientes locais por `remoteAddress`;
4. `strict: false` segue ativo e ainda ha pontos dinamicos fora da primeira fatia tipada;
5. `project.ts` ainda carrega funcoes legadas de config/projeto que hoje sao mascaradas pelos exports do `project-resolver`.

## Achados resolvidos desde a varredura anterior

### Resolvido - Configs malformadas nao derrubam mais o daemon

Evidencias:

- `src/daemon/project-resolver.ts:69`
- `src/daemon/project-resolver.ts:90`
- `src/daemon/project-resolver.ts:441`
- testes `refreshWorkspace records invalid config and project diagnostics without throwing`
- testes `invalid plugin config returns empty plugin config with issue`
- testes `project catalog ignores invalid project json while keeping valid projects`

Status:

O fluxo atual captura erro de `.pluginroblox.json`, `argon.toml` e `.project.json` invalido, registra issues/diagnosticos e mantem o daemon vivo. Este antigo P1 pode ser fechado.

### Resolvido - Mojibake visivel esta coberto

Evidencias:

- teste `P1 source files do not contain common mojibake markers`
- `npm.cmd test` passou com essa verificacao.

Status:

O risco antigo de strings corrompidas visiveis caiu bastante. Manter o teste como guardrail.

### Resolvido - Multi-root nao usa mais sempre a primeira pasta

Evidencias:

- `vscode-extension-src/extension.ts:129`
- teste `VS Code extension resolves multi-root workspaces from the active editor first`

Status:

A extensao agora resolve pela pasta do editor ativo. Ainda ha melhoria ergonomica possivel: quando houver multiplas pastas e nenhum editor ativo, trocar o erro por um QuickPick.

### Resolvido - Empacotamento VSIX gera pacote valido no ambiente alvo

Evidencias:

- `npm.cmd run package:vsix` gerou `dist/amarillo-vscode-1.0.32.vsix`.
- testes `package-vsix copies the daemon runtime recursively`, `package-vsix keeps packaged runtime portable` e `package-vsix includes the shared Amarillo version manifest`.

Status:

No Windows atual o pacote esta validado. A limitacao restante e portabilidade fora do Windows.

### Resolvido - MCP nativo do Codex tem diagnostico seguro

Evidencias:

- `vscode-extension-src/codex-mcp.ts`
- `vscode-extension-src/mcp-config.ts:140`
- `vscode-extension-src/extension.ts`
- `tests/codex-mcp.test.ts`
- `tests/extension-routes.test.ts`
- `VsixGenerator.md`

Status:

O Amarillo agora verifica `codex mcp list` pelo lado da extensao, classifica o registro nativo do Codex e mostra o comando seguro `codex mcp add amarillo -- node "<workspace>/.vscode/amarillo-mcp-bootstrap.cjs" --workspace "<workspace>"` no MCP Healthcheck/Doctor quando necessario. O fluxo nao executa `codex mcp add` automaticamente e nao copia bridge tokens para config compartilhada.

### Resolvido - Descoberta de projetos ignora pastas geradas e locais

Evidencias:

- `src/daemon/project-discovery.ts`
- `vscode-extension-src/project-discovery.ts`
- `src/daemon/project-resolver.ts`
- `src/daemon/app.ts`
- `vscode-extension-src/extension.ts`
- testes `workspace discovery ignores generated and local project directories`
- testes `daemon and VS Code extension use the same project discovery ignore list`
- testes `project discovery file event and extension paths use shared helpers`

Status:

Daemon e extensao agora usam a mesma lista canonica de diretorios ignorados: `.git`, `node_modules`, `.agent`, `.amarillo`, `.vscode`, `dist` e `build`. A descoberta de `.project.json`, o watcher do daemon e o filtro de eventos da extensao ignoram projetos dentro dessas pastas, mantendo projetos validos em pastas normais e herancas por `extends`.

### Resolvido parcialmente - Tipagem segura dos contratos centrais

Evidencias:

- `src/daemon/contracts/runtime.ts`
- `src/daemon/contracts/mcp.ts`
- `src/daemon/app.ts`
- `src/daemon/mcp.ts`
- `src/daemon/mcp-tools.ts`
- `vscode-extension-src/extension.ts`
- testes `validateToolArguments rejects missing required arguments`
- testes `validateToolArguments rejects invalid primitive types`
- testes `validateToolArguments rejects enum values outside the schema`
- testes `validateToolArguments preserves valid argument objects`
- teste `P3 typing guardrails keep central contracts away from broad any`

Status:

A primeira fatia segura do P3 removeu o indice amplo de `PluginRobloxApp`, tipou sessoes/projetos/sync/diagnosticos centrais, adicionou contratos MCP, tipou `validateToolArguments()` e transformou `requestJson()` da extensao em generic. O comportamento runtime, payloads HTTP/MCP e `strict: false` global foram mantidos como estavam. O trabalho restante e evoluir strict por modulo e reduzir os pontos dinamicos fora dessa fatia.

## Achados priorizados

### P2 - Consultas de activity/MCP audit ainda escalam mal com historico grande

Arquivos/linhas:

- `src/daemon/lib/activity-log.ts:114`
- `src/daemon/lib/activity-log.ts:178`
- `src/daemon/lib/activity-log.ts:202`
- `src/daemon/lib/mcp-audit-log.ts:88`
- `src/daemon/lib/mcp-audit-log.ts:148`
- `src/daemon/lib/mcp-audit-log.ts:172`
- `src/daemon/lib/error-tracker.ts:396`

Problema:

`query()` coleta todos os JSONL diarios, faz parse de tudo, ordena todos os registros e so depois aplica `limit`. `summary()` tambem chama `query()` sem limite. Com muitas semanas de atividade, `/activity`, `/activity/summary`, MCP audit e Doctor podem ficar lentos.

Impacto:

Quanto mais o Amarillo for usado em projetos reais, maior sera o custo de abrir Doctor/sidebar/diagnosticos. Isso tambem aumenta o risco de travar a extensao em maquinas mais fracas.

Sugestao:

- Ler diretorios diarios do mais recente para o mais antigo.
- Aplicar limite durante a leitura quando filtros permitirem.
- Manter resumo incremental por dia.
- Adicionar teste de performance com muitos arquivos diarios e `limit` pequeno.

### P2 - `fs.watch` recursivo continua Windows/macOS-first

Arquivos/linhas:

- `src/daemon/app.ts:1143`
- `src/daemon/app.ts:1147`
- `package.json` `engines.node >=22.0.0`

Problema:

O projeto se declara Windows-first, mas o pacote nao declara restricao de SO. Em Linux, `fs.watch(..., { recursive: true })` pode falhar ou se comportar de forma diferente dependendo do ambiente.

Impacto:

Em CI Linux ou em usuario tentando rodar fora do Windows, o daemon pode iniciar sem watcher funcional ou falhar no inicio da observacao de arquivos.

Sugestao:

- Tratar erro do watcher e cair para polling simples ou watchers por diretorio.
- Expor aviso no Doctor quando o watcher nao estiver ativo.
- Documentar oficialmente suporte Windows-first no runtime/VSIX ou declarar restricao de OS.

### P2 - `package:vsix` depende de PowerShell `Compress-Archive`

Arquivos/linhas:

- `scripts/package-vsix.ts:100`
- `scripts/package-vsix.ts:110`
- `scripts/package-vsix.ts:113`
- `tests/package-vsix.test.ts:47`
- `tests/package-vsix.test.ts:48`

Problema:

O empacotador principal chama PowerShell `Compress-Archive`. Isso funciona no alvo Windows e foi validado nesta maquina, mas limita Linux/macOS e runners de CI sem PowerShell.

Impacto:

Contribuidores fora do Windows podem conseguir build/test, mas falhar no pacote final.

Sugestao:

- Migrar o zip para biblioteca Node.
- Ou manter PowerShell e declarar `package:vsix` como Windows-only.
- Adicionar CI Windows se essa dependencia continuar.

### P2 - Rate limit agrupa Studio, VS Code, MCP e chamadas locais no mesmo bucket

Arquivos/linhas:

- `src/daemon/app.ts:2739`
- `src/daemon/app.ts:2740`
- `src/daemon/lib/rate-limiter.ts:4`
- `src/daemon/lib/rate-limiter.ts:48`

Problema:

O rate limiter usa `remoteAddress`. Studio plugin, VS Code, MCP proxy e chamadas manuais locais tendem a aparecer como `127.0.0.1` ou equivalente. Bursts legitimos podem competir no mesmo limite.

Impacto:

Uma automacao MCP intensa pode causar `429` para Studio ou VS Code no mesmo segundo, mesmo com todos os clientes autorizados.

Sugestao:

- Usar chave composta por rota + origem + token quando disponivel.
- Excluir ou ajustar long-poll/health probes internos.
- Registrar no Doctor quando houver rate limit recente.

### P3 - Strict por modulo ainda nao esta ativo

Arquivos/linhas de exemplo:

- `tsconfig.base.json` com `strict: false`
- pontos dinamicos restantes em daemon, extensao, rotas e payloads de Studio

Problema:

O typecheck passa e a primeira fatia segura ja tipou os contratos centrais mais perigosos, mas o repo ainda usa `strict: false`. Alguns fluxos continuam dinamicos por escolha de compatibilidade, especialmente payloads de Studio e respostas HTTP variadas.

Impacto:

Regressoes em campos menos exercitados ainda podem depender de testes especificos em vez de falhar no typecheck.

Sugestao:

- Criar tsconfig strict incremental para um modulo pequeno por vez.
- Comecar por contratos MCP e helpers puros antes de `app.ts`.
- Evitar ligar `strict` global ate reduzir os dinamicos restantes.

### P3 - Parser TOML continua propositalmente simples

Arquivos/linhas:

- `src/daemon/project-resolver.ts:24`
- `src/daemon/project-resolver.ts:50`
- `src/daemon/project.ts:75`
- `src/daemon/project.ts:101`

Problema:

`parseSimpleToml()` suporta apenas `key = value` simples. Ele nao cobre TOML completo, secoes, strings com escapes, comentarios inline ou estruturas mais complexas.

Impacto:

Um `argon.toml` valido para outras ferramentas pode ser lido parcialmente pelo Amarillo.

Sugestao:

- Documentar claramente o subconjunto aceito.
- Preferir `.pluginroblox.json` como configuracao principal.
- Se compatibilidade com Argon/Rojo for prioridade, usar parser TOML real.

### P3 - `project.ts` ainda contem parser/config legado duplicado

Arquivos/linhas:

- `src/daemon/project.ts:71`
- `src/daemon/project.ts:101`
- `src/daemon/project.ts:120`
- `src/daemon/project.ts:129`
- `src/daemon/project.ts:1485`
- `src/daemon/project.ts:1495`

Problema:

`project.ts` ainda contem funcoes antigas de parse/config/projetos, mas exporta as versoes do `project-resolver` no final. Hoje isso nao quebrou os testes, mas deixa o arquivo ambigue e aumenta risco de alguem chamar a implementacao errada durante refactor.

Sugestao:

- Remover funcoes legadas nao usadas.
- Manter `project.ts` focado em estado local/syncback.
- Adicionar guardrail para impedir reintroducao de descoberta/config duplicada.

### P3 - Respostas HTTP locais sao bufferizadas sem limite no proxy/extensao

Arquivos/linhas:

- `src/mcp-proxy/index.ts:78`
- `src/mcp-proxy/index.ts:80`
- `vscode-extension-src/extension.ts:1399`
- `vscode-extension-src/extension.ts:1401`

Problema:

O daemon limita o tamanho de requests, mas o proxy MCP e a extensao acumulam `responseBody` sem teto explicito. Em rotas como `get_tree`, `get_output_log`, Doctor ou respostas de erro grandes, isso pode consumir memoria demais.

Sugestao:

- Adicionar limite maximo configuravel de bytes de resposta.
- Retornar erro amigavel quando a resposta exceder o limite.
- Para logs/tree, considerar paginacao ou profundidade/limite default menor.

## Itens que estao bons

- Build, typecheck, testes, audit e VSIX passaram.
- Rotas protegidas por bridge token e session token possuem cobertura.
- Operacoes destrutivas MCP passam por gates de saude/confirmacao e geram audit log.
- Configs/projetos invalidos viram diagnostico em vez de derrubar daemon.
- `clean-generated` valida roots antes de apagar JS gerado.
- `package-vsix` valida referencias locais proibidas no payload.
- O healthcheck/Doctor cobre rotas leves do daemon, MCP, versoes, sessoes, erros e activity.
- Plugin tem testes para versao/protocolo, polling adaptativo, session token, cache de propriedades e limites de registradores da UI.

## Proxima ordem sugerida

1. Otimizar `ActivityLog` e `McpAuditLog` para historicos grandes.
2. Blindar `fs.watch` com fallback e aviso no Doctor.
3. Refinar rate limiter para separar clientes locais autorizados.
4. Migrar `package:vsix` para zip Node ou declarar Windows-only.
5. Evoluir `strict` por modulo e tipar pontos dinamicos restantes.
6. Remover duplicacao legada em `project.ts`.
