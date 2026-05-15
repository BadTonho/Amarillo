# Project Analysis & Optimization Plan: Amarillo

Após analisar o código-fonte do projeto Amarillo, incluindo o Daemon (`app.ts`), a Extensão VS Code (`extension.ts`) e o Plugin do Roblox Studio (`Amarillo.lua`), identifiquei diversas oportunidades de melhoria e otimização. 

O projeto atual apresenta uma arquitetura funcional, mas sofre com o antipadrão de **"God Objects" (Objetos/Arquivos Monolíticos)**, onde arquivos gigantes concentram dezenas de responsabilidades. Isso dificulta a manutenção, aumenta a chance de bugs e torna o código difícil de testar.

Abaixo, detalho as sugestões de melhorias arquiteturais, organizadas por componente.

## Proposed Changes

### 1. Refatoração dos Arquivos Monolíticos (God Classes)

Atualmente, o projeto possui três arquivos principais gigantescos:
* `src/daemon/app.ts` (mais de 3000 linhas)
* `vscode-extension-src/extension.ts` (mais de 3700 linhas)
* `src/plugin/Amarillo.lua` (mais de 3800 linhas)

**Solução Sugerida:**
- **Extensão (`extension.ts`):** Extrair responsabilidades para arquivos menores. 
  - `commands.ts` para registrar os comandos da Command Palette.
  - `sidebar.ts` para lidar com a UI do Webview e lógica de renderização.
  - `daemon-manager.ts` para lidar com a inicialização e ciclo de vida do processo filho (Node.js).
  - `mcp-bridge.ts` para as funções relacionadas ao Codex MCP.
- **Daemon (`app.ts`):** A classe `PluginRobloxApp` faz *tudo*, desde roteamento HTTP até controle de watchers e checagem de versão.
  - Criar um `HttpServerManager.ts` para gerenciar as rotas.
  - Criar um `SyncManager.ts` para lidar com o estado de sincronização (hashes, debounces, etc).
  - Extrair a lógica de autenticação (`isBridgeRequestAuthorized`) para um middleware de segurança.
- **Plugin (`Amarillo.lua`):** 
  *(Nota: Como o projeto Amarillo substitui o Rojo e tem uma função similar/melhorada, a fragmentação do código Lua pode ser mais complexa sem um empacotador externo próprio. Porém, ainda seria recomendado ter um script que concatene arquivos Lua separados na hora da build (`build:scripts`), facilitando assim o desenvolvimento em arquivos menores como `SyncManager.lua`, `HttpService.lua`, e `UI.lua` e gerando o `Amarillo.lua` final.)*

### 2. Centralização de Tipos e Contratos Compartilhados

Notei que muitas interfaces (ex: `BridgeSessionPayload`, `McpShieldPayload`) estão definidas no topo do `extension.ts`, enquanto o daemon usa definições similares no `app.ts` e arquivos dentro de `src/daemon/contracts/`.

**Solução Sugerida:**
- Criar uma pasta `src/shared` ou `src/contracts`.
- Mover todas as interfaces HTTP e definições de payload para lá.
- Fazer com que tanto o Daemon quanto a Extensão VS Code importem do mesmo lugar. Isso garante que não haverá quebra de compatibilidade silenciosa se um lado mudar a API e o outro não.

### 3. Melhoria no Gerenciamento de Estado (State Machine)

A extensão gerencia o estado da Sidebar e da conexão usando dezenas de variáveis globais booleanas e timers:
```typescript
let sidebarHandshakeCycleKey = null;
let sidebarStartPromptShown = false;
let sidebarOfferRequested = false;
let sidebarOfferRequestInFlight = false;
```
Isso causa "Race Conditions" e estados inconsistentes.

**Solução Sugerida:**
- Implementar uma Máquina de Estados (State Machine) explícita para o ciclo de vida do Daemon (Ex: `STOPPED` -> `STARTING` -> `RUNNING` -> `ERROR`).
- Mudar para um fluxo unidirecional onde a Sidebar apenas reflete o estado atual da "Engine", em vez de reagir a callbacks e timers espalhados.

### 4. Otimização de Performance e I/O (Daemon)

- **Debounce e Burst Limits:** As constantes `SCRIPT_PATCH_DEBOUNCE_MS` e `SCRIPT_PATCH_BURST_LIMIT` estão corretas na teoria, mas dentro do `app.ts` a manipulação do `pendingStudioWrites` pode estourar memória se muitas requisições vierem ao mesmo tempo.
- **Watchers:** O uso de `FSWatcher` diretamente do Node (módulo `fs`) pode ter comportamento instável no Windows. Uma reescrita cuidadosa para evitar locks de arquivo no Windows e processamento duplicado deve ser priorizada.

### 5. Error Handling Defensivo no Studio

- Como visto nos logs anteriores (`RBXRefinementScale`), o plugin é vulnerável a permissões de CoreScript do Roblox.
- Toda modificação de propriedade (`instance[propertyName] = value`) ou adição de filhos (`instance.Parent = newParent`) deve ser obrigatoriamente encapsulada em `pcall` com um log claro sobre qual propriedade ou instância falhou. Criar uma função utilitária `safeSetProperty` no Lua que faça isso em todo o projeto reduz o código e aumenta a confiabilidade.
