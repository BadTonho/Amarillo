# Avaliação de Segurança e Blindagem do Amarillo

Fiz uma análise detalhada da arquitetura do projeto (`src/daemon`, `vscode-extension`, e `mcp-proxy`), focando em como os dados são recebidos do Roblox Studio e processados no PC. 

Existem **duas vulnerabilidades críticas de Path Traversal** na camada de sincronização do Daemon. Como o daemon opera como uma ponte bidirecional entre o Studio (que pode rodar plugins de terceiros maliciosos) e o file system local do usuário, proteger essas entradas é essencial.

---

## 1. Vulnerabilidades Críticas Encontradas

### A. Path Traversal no Endpoint `/studio/patch-source`
- **Onde:** `src/daemon/project.ts` -> `patchStudioFileSource()`
- **Problema:** Quando você edita um script no Studio, o plugin envia um `POST /studio/patch-source` contendo o `path` (ex: `game.Workspace.Script`) e o `source`. O daemon normaliza esse caminho quebrando nos pontos (`.`). Porém, **se um script malicioso ou plugin de terceiros enviar um path contendo `..`**, o daemon fará `path.join("C:/Workspace/src", "..", "..", "malicious")`.
- **Risco:** Escrita arbitrária de arquivos em qualquer lugar do sistema do usuário (desde que seja adicionado com a extensão `.luau` ou `.lua`), podendo escapar totalmente do `workspaceRoot`.
- **Blindagem Sugerida:**
  1. A função `normalizeInstancePathSegments` deve rejeitar ou filtrar ativamente os segmentos `.` e `..`.
  2. Antes de aplicar a escrita `writeTextFileIfChanged`, a função deve utilizar o método `isPathInside(currentPath, bestMount.absolutePath)` para garantir que o arquivo final resida unicamente dentro da pasta permitida.

### B. Path Traversal na Criação de Snapshots (Sync)
- **Onde:** `src/daemon/project.ts` -> `nodeFsName(node)` e `writeStudioProjectStateAsync()`
- **Problema:** O método `POST /studio/snapshot` envia a árvore de arquivos completa. O daemon usa `nodeFsName(node)` para decidir qual será o nome da pasta ou do arquivo no disco. Esse método retorna o `node.fsName` ou `node.name` diretamente como veio do JSON, **sem sanitização**. Se um node malicioso tiver o nome `../../../malicious.exe.luau`, o `path.join` vai jogar o arquivo para fora do projeto.
- **Risco:** Outra vetor de escrita arbitrária via sincronização massiva, e também de **deleção de arquivos** (o cleanup do Syncback deletará recursivamente o que encontrar fora do lugar se o path resolver maliciosamente).
- **Blindagem Sugerida:**
  1. O método `nodeFsName` deve remover e neutralizar ativamente slashes (`/` e `\`) e `..`. Nomes de objetos no Roblox não devem poder controlar caminhos relativos de sistema de arquivos.
  2. Implementar uma checagem rigorosa de `isPathInside` antes de invocar as rotinas de `mkdir` e `writeFile`.

---

## 2. Robustez Geral e Boas Práticas

### A. Proteção do Bridge Token e Isolamento (MCP)
- O fato do token agora ser persistente (via nosso fix de sincronização) expõe um risco contínuo: qualquer pessoa com acesso à porta do Daemon (8323 por padrão) + o token no `workspaceState` pode invocar o MCP Proxy e chamar ferramentas com alto privilégio, incluindo `run_code` (execução arbitrária de Luau no Studio do host).
- A atual proteção HTTP rejeita rotas de controle se o token for inválido, porém como é um serviço localhost contínuo, a blindagem já implementada com o `timingSafeEqualString` (em `app.ts`) contra ataques de *timing* foi uma ótima decisão de design original. Nenhuma mudança imediata se faz necessária, mas alerto para a manutenção severa de não expor `bridgeToken` em logs ou respostas de erro vazadas do MCP Proxy.

### B. Proteção contra CSRF Involuntário
- As requisições originárias do browser poderiam atingir o Daemon. Devido à presença obrigatória do cabeçalho `X-Amarillo-Bridge-Token` e/ou `Session-Token`, a checagem no `authorizeHttpRequest` de `app.ts` impede CORS de leitura ou CORS POST de origens maliciosas porque `fetch` exigiria um Preflight (OPTIONS) por causa de headers customizados.
- **Atenção:** Assegure-se de que o Daemon *não* responda positivamente a chamadas `OPTIONS` vindas de qualquer `Origin`, caso você inclua suporte a CORS no futuro. Atualmente, requisições diretas simples falharão na checagem de token e não representarão perigo.

### C. Limite de Tamanho de JSON 
- O arquivo `http-utils.ts` define `STUDIO_SYNC_MAX_JSON_BODY_BYTES`, o que é uma excelente blindagem contra ataques de exaustão de memória (OOM), já que uma Place grande no Roblox poderia gerar um snapshot de 200MB+. Mantenha-se rigoroso a esse limite para não crachar o processo do NodeJS (V8 heap).
