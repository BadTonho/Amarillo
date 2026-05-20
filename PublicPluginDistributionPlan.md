# Plano para corrigir o limite de locals do plugin Amarillo

Este plano existe para corrigir o erro que aparece no Roblox Studio:

```text
user_Amarillo.lua.Script:4118: Out of local registers when trying to allocate createPluginUi: exceeded limit 200
```

Esse erro nao e causado por `createPluginUi` em si. Ele aparece ali porque o Roblox Studio tentou criar mais um `local function`, mas o arquivo gerado ja tinha locals demais no mesmo chunk Luau.

O problema atual vem deste fluxo:

```text
src/plugin-src/*.lua
        |
        v
scripts/build-plugin.ts concatena tudo
        |
        v
src/plugin/Amarillo.lua
```

Como tudo vira um arquivo unico, os `local`, `local function` e forward declarations de topo somam no mesmo escopo. O Studio bate no limite antes de terminar de compilar o plugin.

## Regra fixa

Antes de qualquer passo:

- Nao editar `src/plugin/Amarillo.lua` manualmente.
- Editar somente `src/plugin-src/*.lua`.
- Depois regenerar com:

```powershell
npm.cmd run build:plugin
```

`src/plugin/Amarillo.lua` e artefato gerado. Se corrigir direto nele, a mudanca pode sumir no proximo build.

## Passo 1: corrigir o erro atual encapsulando `80_ui.lua`

Este e o passo mais importante. Ele deve vir antes de qualquer teste de budget.

Hoje `src/plugin-src/80_ui.lua` cria muitas funcoes locais no topo:

```lua
local function openConnectionPrompt(context)
	-- ...
end

local function connectSession()
	-- ...
end

local function createPluginUi()
	-- ...
end

createPluginUi()
```

Essas funcoes entram no escopo principal do `Amarillo.lua` gerado. Como `80_ui.lua` aparece tarde no arquivo, o Studio ja esta perto do limite quando chega em `createPluginUi`.

O que fazer:

- Envolver o conteudo de `80_ui.lua` em uma funcao inicializadora.
- Manter os helpers da UI como `local function` dentro dessa funcao.
- Chamar a inicializadora no final do arquivo.

Formato alvo:

```lua
local function initializeUiModule()
	state.uiActions = state.uiActions or {}

	local function openConnectionPrompt(context)
		-- ...
	end

	local function connectSession()
		-- ...
	end

	local function createPluginUi()
		-- ...
	end

	createPluginUi()
end

initializeUiModule()
```

Por que isso funciona:

- `initializeUiModule` vira apenas um local de topo.
- Os muitos `local function` da UI passam a existir dentro do escopo da inicializadora.
- O chunk principal deixa de acumular todos os locals da UI.
- O plugin deve parar de bater no limite antes de `createPluginUi`.

Pronto quando:

- `80_ui.lua` tiver apenas a inicializadora como local de topo principal.
- `createPluginUi` estiver dentro de `initializeUiModule`.
- O arquivo gerado continuar chamando a UI uma vez no carregamento.

## Passo 2: exportar somente o que `90_watchers_loops.lua` precisa

Ao encapsular `80_ui.lua`, funcoes locais da UI deixam de ficar visiveis para os arquivos que vem depois no bundle.

Pelo estado atual do codigo, `90_watchers_loops.lua` chama esta funcao definida em `80_ui.lua`:

```lua
pollConnectionOffer()
```

Entao ela precisa ser exposta explicitamente.

O que fazer em `80_ui.lua`:

```lua
state.uiActions.pollConnectionOffer = function()
	-- corpo atual de pollConnectionOffer
end
```

Se quiser manter o nome local dentro da UI para botoes/callbacks internos:

```lua
local function pollConnectionOffer()
	return state.uiActions.pollConnectionOffer()
end
```

Ou simplesmente trocar as chamadas internas para:

```lua
state.uiActions.pollConnectionOffer()
```

O que fazer em `90_watchers_loops.lua`:

Trocar:

```lua
local reqOk, reqResponse = pollConnectionOffer()
```

por:

```lua
local reqOk, reqResponse = state.uiActions.pollConnectionOffer()
```

Opcionalmente, usar uma protecao para erro mais claro:

```lua
if not state.uiActions or not state.uiActions.pollConnectionOffer then
	appendLog("UI actions not initialized; skipping connection offer poll.")
	task.wait(OFFER_RETRY_POLL_INTERVAL)
	continue
end

local reqOk, reqResponse = state.uiActions.pollConnectionOffer()
```

Pronto quando:

- `90_watchers_loops.lua` nao chamar mais `pollConnectionOffer` direto.
- A chamada passar por `state.uiActions.pollConnectionOffer`.
- O loop de offer continuar funcionando quando o plugin estiver desconectado.

## Passo 3: regenerar o plugin

Depois de alterar `src/plugin-src/80_ui.lua` e `src/plugin-src/90_watchers_loops.lua`, rodar:

```powershell
npm.cmd run build:plugin
```

Conferir no gerado:

```text
src/plugin/Amarillo.lua
```

O que procurar:

- O banner de arquivo gerado continua no topo.
- Existe `local function initializeUiModule()`.
- `createPluginUi` esta dentro de `initializeUiModule`.
- O final da secao de UI chama `initializeUiModule()`.
- `90_watchers_loops.lua` chama `state.uiActions.pollConnectionOffer()`.

Pronto quando:

- `src/plugin/Amarillo.lua` foi regenerado pelo build.
- Nenhuma mudanca manual foi feita diretamente no gerado.

## Passo 4: testar a correcao no Roblox Studio

Este passo confirma se o erro real foi resolvido.

O que fazer:

- Instalar a VSIX ou reinstalar o plugin pelo fluxo normal.
- Rodar:

```text
Amarillo: Install Roblox Studio Plugin
```

- Reabrir ou recarregar o Roblox Studio.
- Conferir o Output.

Resultado esperado:

```text
Nao aparece "Out of local registers".
Botao do plugin aparece na toolbar.
UI do plugin abre.
Prompt de conexao aparece quando existir offer.
Status/log do plugin atualiza.
```

Se o erro continuar:

- Verificar se o Studio esta usando o plugin novo, nao uma instalacao antiga.
- Confirmar que `src/plugin/Amarillo.lua` regenerado contem `initializeUiModule`.
- Procurar o novo nome citado pelo erro. Se ele apontar para outro modulo posterior, repetir o mesmo padrao de encapsulamento nesse modulo.

## Passo 5: rodar testes locais

Depois que a correcao carregar no Studio, rodar:

```powershell
npm.cmd run build:plugin
npm.cmd test
```

Se quiser uma verificacao mais ampla:

```powershell
npm.cmd run check
```

Pronto quando:

- `build:plugin` passa.
- `npm.cmd test` passa.
- Os testes existentes que procuram strings em `Amarillo.lua` foram atualizados, se necessario, para o novo formato encapsulado.

## Passo 6: adicionar guardrail de budget depois da correcao

So depois do plugin voltar a carregar no Studio, adicionar uma checagem para impedir regressao.

O que fazer:

- Criar um script/teste para contar locals de topo no gerado.
- Locais sugeridos:

```text
scripts/check-plugin-register-budget.ts
tests/plugin-register-budget.test.ts
```

- Limites sugeridos apos encapsular a UI:

```text
Avisar acima de 160 locals de topo.
Falhar acima de 180 locals de topo.
```

- Conectar em:

```text
npm.cmd test
npm.cmd run check
```

Pronto quando:

- O teste falha se alguem voltar a adicionar muitos locals de topo.
- A mensagem de falha explica que o problema e o limite de registradores locais do Luau.

## Passo 7: repetir o padrao nos proximos modulos grandes

Se ainda ficar perto do limite, repetir o encapsulamento nestes arquivos:

```text
src/plugin-src/40_snapshot_sync.lua
src/plugin-src/50_commands.lua
src/plugin-src/60_connection_flow.lua
```

Ordem recomendada:

1. `40_snapshot_sync.lua`
2. `50_commands.lua`
3. `60_connection_flow.lua`

Regra:

- Helpers privados ficam `local` dentro da inicializadora do modulo.
- Funcoes usadas por outros modulos devem ser expostas em tabelas explicitas, como:

```lua
state.snapshotActions = state.snapshotActions or {}
state.commandActions = state.commandActions or {}
state.connectionActions = state.connectionActions or {}
```

Pronto quando:

- O arquivo gerado ficar bem abaixo do limite.
- Nenhum modulo depender de locals invisiveis criados por concatenacao.

## Passo 8: decidir arquitetura publica de longo prazo

Depois da correcao imediata, escolher o caminho para distribuicao publica.

Opcao recomendada para plugin publico:

```text
Gerar um plugin Roblox com ModuleScripts reais.
```

Exemplo:

```text
PluginScript principal
Modules/
  Bootstrap
  SettingsStatus
  Http
  ValuesProperties
  SnapshotSync
  Commands
  ConnectionFlow
  PrivilegedActions
  Ui
  WatchersLoops
```

Alternativa aceitavel:

```text
Continuar com arquivo unico, mas cada fragmento deve ser isolado por funcao no bundler.
```

Pronto quando:

- O plugin atual carrega sem erro.
- O release publico nao depende de edicoes manuais.
- O build/teste impede regressao.
- A estrategia de longo prazo esta documentada no README ou no checklist de release.

## Definicao final de pronto

O trabalho inteiro esta pronto quando:

- O erro `Out of local registers` nao aparece mais no Roblox Studio.
- `createPluginUi` esta encapsulado e nao consome local de topo no chunk principal.
- `90_watchers_loops.lua` chama a API da UI por `state.uiActions`.
- O plugin foi regenerado por `npm.cmd run build:plugin`.
- O plugin foi testado pelo fluxo normal de instalacao.
- Existe guardrail para impedir que o limite volte a ser estourado.

