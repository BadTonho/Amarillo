# Amarillo Optimization Findings

Gerado em 2026-05-15.

Este arquivo registra uma revisao geral do estado atual do Amarillo apos os itens 4 e 5 do plano de otimizacao. O foco aqui e apontar melhorias de arquitetura, performance, confiabilidade e manutencao que ainda valem ser atacadas.

## Snapshot Atual

- O repo esta funcional, mas ainda concentra muita responsabilidade em poucos arquivos.
- Maiores arquivos observados:
  - `src/plugin/Amarillo.lua`: ~3571 linhas.
  - `src/daemon/app.ts`: ~3025 linhas.
  - `vscode-extension-src/extension.ts`: ~2505 linhas.
  - `tests/daemon-handshake.test.ts`: ~1921 linhas.
  - `src/daemon/project.ts`: ~1438 linhas.
- A extracao da sidebar, tipos e state machine ja comecou, mas ainda existem duplicacoes e estados paralelos.
- O build ainda gera/usa JS ao lado de fontes TS em varias areas, o que facilita execucao local, mas aumenta ruido em busca, revisao e guardrails.

## Achados Prioritarios

### P0 [concluido] - `run_code` deve ser tratado como operacao privilegiada

**Evidencia:** `src/daemon/app.ts` classifica como destrutivas apenas `modify_property`, `create_instance`, `delete_instance` e `insert_model`. O comando `run_code`, exposto via MCP/daemon/plugin, pode executar Luau arbitrario no Studio e portanto pode destruir instancias, alterar propriedades, iniciar processos ou vazar dados do ambiente.

**Risco:** mesmo com confirmacao para comandos destrutivos explicitos, um cliente MCP pode fazer a mesma coisa por `run_code`.

**Acao sugerida:** adicionar uma politica separada para comandos privilegiados:
- `run_code` deve exigir confirmacao no plugin ou uma flag explicita de confianca.
- Doctor deve mostrar quando execucao arbitraria esta habilitada.
- MCP instructions devem orientar clientes a usar `run_code` somente para leitura/diagnostico, salvo confirmacao humana.
- Adicionar testes de policy para garantir que `run_code` nao burla o gate destrutivo.

### P1 [concluido] - State machine da extensao esta parcialmente duplicada

**Evidencia:** `vscode-extension-src/bridge-state.ts` possui `BridgeStateMachine`, mas `vscode-extension-src/extension.ts` ainda mantem `let daemonProcess = null` e manipula o processo diretamente em varios pontos. A state machine tambem possui `_daemonProcess`, `setDaemonProcess`, `clearDaemonProcess` e `transitionTo`.

**Risco:** dois donos do processo podem divergir. Exemplo: status bar pode acreditar que o bridge esta parado enquanto `daemonProcess` local ainda existe, ou o inverso.

**Acao sugerida:** escolher um unico dono:
- Mover todo acesso a processo para `BridgeStateMachine`.
- Expor metodos `startProcess`, `attachProcess`, `killProcess`, `markProcessClosed`.
- Remover `daemonProcess` global da extensao.
- Cobrir com testes de estado: start, erro no spawn, close, manual stop e dispose.

### P1 [concluido] - Fonte canonica de tipos compartilhados esta invertida

**Evidencia:** `src/shared/api-types.ts` reexporta de `../../vscode-extension-src/api-types`. Isso faz o daemon depender conceitualmente de uma pasta da extensao, e exigiu incluir `src/shared/**/*.ts` no `tsconfig.daemon.json`.

**Risco:** o nome `src/shared` sugere fonte canonica, mas a fonte real vive na extensao. Isso pode gerar confusao, ciclos de build e artefatos JS inesperados em `vscode-extension-src` quando alguem compila com configuracao diferente.

**Acao sugerida:**
- Mover o conteudo canonico para `src/shared/api-types.ts`.
- Fazer `vscode-extension-src/api-types.ts` reexportar de `../src/shared/api-types`, ou importar diretamente de `src/shared`.
- Ajustar `tsconfig.extension.json` para permitir essa importacao sem emitir JS em pastas fonte indevidas.
- Adicionar teste de guardrail para garantir que o shared nao importe de `vscode-extension-src`.

### P1 [concluido] - `PluginRobloxApp` ainda e um God Object operacional

**Evidencia:** mesmo com rotas extraidas, `src/daemon/app.ts` ainda contem HTTP lifecycle, auth, sessions, sync, activity revert, workspace watcher, disk-write queue, doctor report, diff e policies.

**Risco:** mudancas pequenas em sync ou diagnostico continuam tocando uma classe de alto impacto. Isso aumenta risco de regressao e torna testes mais caros.

**Acao sugerida:** extrair por responsabilidade, sem mudar contratos HTTP:
- `SessionRegistry`: open/reclaim/summary/contact/version/session tokens.
- `SyncCoordinator`: enqueue/complete/reject/guards/degraded/verified.
- `WorkspaceWatcher`: `fs.watch`, dedupe, project-tree scheduling.
- `StudioSnapshotWriter`: pending writes, coalescing, disk writes, drain.
- `DoctorService`: report aggregation.

### P1 [concluido] - Escrita Studio -> disco ainda bloqueia o event loop

**Evidencia:** `writeStudioProjectState` em `src/daemon/project.ts` usa `fs.writeFileSync`, `fs.rmSync`, `fs.readFileSync` e percorre diretorios de forma sincrona. O item 4 reduziu explosao de jobs, mas cada job ainda pode bloquear o daemon durante snapshots grandes.

**Risco:** snapshots grandes ou muitos assets podem atrasar long-poll, MCP calls e health checks.

**Acao sugerida:**
- Criar `writeStudioProjectStateAsync` com `fs/promises`.
- Manter limite de concorrencia por mount para nao saturar disco.
- Registrar duracao e numero de arquivos alterados em `logSync`.
- Adicionar benchmark/teste com projeto grande e assertar que health nao fica bloqueado por tempo excessivo.

### P1 [concluido] - Snapshot hashing/serializacao faz trabalho duplicado

**Evidencia:** `hashSnapshot` usa `JSON.stringify` com sort recursivo. `updateStudioSnapshot` tambem calcula `snapshotSize` com `JSON.stringify(snapshot).length`. No plugin, `syncSnapshot` cria JSON do body e tambem JSON da snapshot para comparar cache.

**Risco:** snapshots grandes podem ser serializados varias vezes em daemon e plugin, aumentando CPU e memoria.

**Acao sugerida:**
- Criar helper unico `normalizeAndHashSnapshot(snapshot)` que retorna `{ normalized, hash, byteLength }` com no maximo uma serializacao.
- No endpoint `/studio/snapshot`, usar `Content-Length` como tamanho de request quando disponivel.
- No plugin, evitar `HttpService:JSONEncode(snapshot)` separado quando `bodyJson` ja contem a snapshot, ou cachear hash/JSON juntos.
- Adicionar teste de regressao para garantir que snapshot unchanged nao agenda escrita nem reserializa desnecessariamente.

### P2 [concluido] - Erros defensivos do plugin deveriam chegar ao Doctor

**Evidencia:** os helpers `safeSetProperty`, `safeSetAttribute` e `safeSetParent` escrevem em `appendLog`, mas nem todo erro e agregado via `/errors/add`. Para falhas durante sync automatico, o usuario pode ver apenas log local do widget.

**Risco:** Doctor pode parecer saudavel mesmo se o plugin estiver falhando em aplicar algumas propriedades por permissao de CoreScript.

**Acao sugerida:**
- Agregar falhas de safe-set por apply cycle.
- Enviar um erro resumido para `/errors/add` com propriedade, instancia, comando/reason e contagem.
- Evitar spam usando dedupe por `instance/property/error` em janela curta.

### P2 [concluido] - Testes principais tambem viraram monolitos

**Evidencia:** `tests/daemon-handshake.test.ts` tem ~1921 linhas e cobre handshake, auth, snapshots, sync, activity, MCP, Doctor e destructive gates.

**Risco:** falhas ficam mais dificeis de localizar; setups compartilhados ficam acoplados; fica tentador adicionar mais casos no mesmo arquivo.

**Acao sugerida:**
- Dividir em arquivos por dominio:
  - `daemon-auth.test.ts`
  - `daemon-sync.test.ts`
  - `daemon-activity.test.ts`
  - `daemon-doctor.test.ts`
  - `daemon-destructive.test.ts`
- Mover fixtures para `tests/helpers/workspace.ts`.
- Manter um teste smoke de handshake fim-a-fim.

### P2 [concluido] - Build com JS gerado no meio dos fontes causa ruido

**Evidencia:** existem fontes TS e JS lado a lado em `src/daemon`, `tests` e outros diretorios. O runtime atual usa `node src/daemon/index.js`, entao isso e intencional em parte, mas atrapalha buscas e relatorios porque duplica resultados.

**Risco:** revisoes podem analisar JS gerado em vez de TS; guardrails estaticos podem contar duas vezes; artefatos inesperados podem aparecer em pastas fonte.

**Acao sugerida:**
- Documentar claramente quais JS sao gerados e ignorados.
- Ensinar scripts de analise/guardrail a ignorar JS gerado quando o TS correspondente existir.
- Plano maior: emitir daemon/tests para `dist/` e ajustar scripts para rodarem de la.

### P2 [concluido] - Observabilidade de performance ainda e limitada

**Evidencia:** ha `logSync` sob `AMARILLO_DEBUG`, ActivityLog, ErrorTracker e MCP audit, mas nao ha metricas consistentes para duracao de snapshot, tamanho, arquivos tocados, tempo de poll ou latencia MCP.

**Risco:** fica dificil saber se uma otimizacao realmente melhorou algo ou se um workspace especifico esta degradando.

**Acao sugerida:**
- Adicionar `performance.now()` em pontos chave:
  - read local project state.
  - write Studio snapshot.
  - hash snapshot.
  - enqueue/dequeue command age.
  - MCP call duration.
- Expor resumo em `/doctor` ou `/diagnostics/perf`.
- Criar `npm run bench:sync` com um workspace sintetico.

### P3 - Plugin Lua precisa de pipeline de modularizacao

**Evidencia:** `src/plugin/Amarillo.lua` segue monolitico e ja contem workaround de escopo para evitar limite de registradores do Studio.

**Risco:** cada melhoria aumenta risco de erro de sintaxe, limite de registradores, conflito entre funcoes e dificuldade de revisao.

**Acao sugerida:**
- Criar `src/plugin-src/` com modulos pequenos:
  - `Http.lua`
  - `Sync.lua`
  - `Snapshot.lua`
  - `Commands.lua`
  - `UI.lua`
  - `Settings.lua`
- Criar script `build:plugin` para concatenar em `src/plugin/Amarillo.lua`.
- Adicionar guardrail que verifica ordem de concatenacao e constantes de versao.

### P3 - `sidebar.ts` ja esta extraido, mas ainda cresceu bastante

**Evidencia:** `vscode-extension-src/sidebar.ts` tem ~825 linhas, misturando state builders, HTML renderers, CSS e activity rendering.

**Risco:** fica melhor que o monolito original, mas ainda dificulta iteracao de UI e testes de estado.

**Acao sugerida:**
- Separar em:
  - `sidebar-state.ts`
  - `sidebar-render.ts`
  - `sidebar-styles.ts`
  - `sidebar-activity.ts`
- Manter `sidebar.ts` como facade de exports.

## Ordem Recomendada

1. Fechar o gap de seguranca de `run_code`.
2. Consolidar processo do daemon dentro da `BridgeStateMachine`.
3. Corrigir a direcao do shared API contract.
4. Extrair `StudioSnapshotWriter` e `WorkspaceWatcher` de `PluginRobloxApp`.
5. Tornar `writeStudioProjectState` async ou chunked.
6. Adicionar metricas/benchmarks de sync.
7. Dividir testes e iniciar build modular do plugin Lua.

## Criterios de Aceite Sugeridos

- `npm.cmd run check` passa.
- `node --test` passa com suites divididas.
- Doctor mostra aviso quando execucao arbitraria esta habilitada sem confirmacao.
- Snapshot grande nao bloqueia health/MCP por tempo perceptivel.
- Nenhum contrato compartilhado importa de `vscode-extension-src`.
- Buscas e guardrails ignoram JS gerado quando o TS fonte correspondente existe.
