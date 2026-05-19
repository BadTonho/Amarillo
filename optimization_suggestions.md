# Plano recomendado para corrigir o erro de `local registers`

## Diagnóstico

O erro atual:

```text
Out of local registers when trying to allocate watcherConnections: exceeded limit 200
```

não significa que `watcherConnections` seja necessariamente a causa principal. Ele é provavelmente o primeiro `local` que o compilador tentou criar depois que o chunk gerado já tinha atingido o limite de 200 registros locais.

O ponto central é este: `scripts/build-plugin.ts` concatena todos os arquivos de `src/plugin-src/*.lua` em um único `src/plugin/Amarillo.lua`. Como o resultado é um único chunk Luau, todos os `local`, `local function` e forward declarations de topo continuam vivos até o fim do arquivo. Quando o código chega em `90_watchers_loops.lua`, o chunk já está perto ou acima do limite.

Por isso, a prioridade não deve ser mover variáveis temporárias de loops para `state.*`. Locais dentro de funções normalmente têm escopo próprio e são muito menos perigosos para esse erro. O que precisa cair é a quantidade de `locals` no topo do arquivo gerado.

## O que eu faria primeiro

### Fase 0: garantir que o arquivo gerado está sincronizado

Antes de mexer em comportamento, confirme que `src/plugin/Amarillo.lua` está sendo regenerado a partir de `src/plugin-src/*.lua`.

Comando recomendado:

```powershell
npm.cmd run build:plugin
```

Motivo: o source `src/plugin-src/90_watchers_loops.lua` já tem mudanças que não aparecem iguais no `src/plugin/Amarillo.lua` gerado. Se o plugin instalado estiver usando uma versão antiga, qualquer análise fica confusa.

Nunca edite `src/plugin/Amarillo.lua` manualmente. Ele é artefato gerado.

### Fase 1: remover todos os `locals` de topo em `90_watchers_loops.lua`

Esse é o quick win mais direto, porque o erro aparece exatamente quando o build chega nesse módulo.

Trocar:

```lua
local watcherConnections = {}
local watcherDirty = false
local watcherDirtyAt = 0

local function markDirty()
	...
end
```

por algo sem novos `local` de topo:

```lua
state.watcherConnections = state.watcherConnections or {}
state.watcherDirty = false
state.watcherDirtyAt = 0
state.watchers = state.watchers or {}

state.watchers.markDirty = function()
	...
end
```

Também converter os helpers privados do watcher para campos em `state.watchers`, por exemplo:

```lua
state.watchers.sendScriptPatch = function(path, source)
	...
end

state.watchers.scheduleScriptPatch = function(pathSegments, source)
	...
end
```

Dentro das funções, pode continuar usando `local` normalmente. O problema é o `local` declarado no topo do chunk gerado.

Objetivo dessa fase: fazer `90_watchers_loops.lua` adicionar zero `local`/`local function` no topo.

### Fase 2: reduzir `locals` de topo nos módulos grandes

Se a Fase 1 compilar, ótimo, mas ainda fica frágil. Qualquer novo `local` no fim do plugin pode quebrar de novo.

Depois disso, eu atacaria estes módulos:

1. `80_ui.lua`
2. `40_snapshot_sync.lua`
3. `50_commands.lua`

O padrão recomendado é transformar funções locais de topo em exports por tabela.

Em vez de:

```lua
local function refreshTreePreview()
	...
end

local function connectSession()
	...
end
```

usar:

```lua
state.uiActions = state.uiActions or {}

state.uiActions.refreshTreePreview = function()
	...
end

state.uiActions.connectSession = function()
	...
end
```

Quando outra parte do plugin precisar chamar, usar:

```lua
state.uiActions.refreshTreePreview()
state.uiActions.connectSession()
```

Isso reduz a pressão no limite de registers porque deixa de criar um `local` de topo para cada função.

## Melhor solução estrutural

A solução mais robusta é mudar o estilo do plugin gerado para ter menos símbolos locais de topo.

Modelo desejado:

```lua
local state = {
	...
}

state.api = {}
state.uiActions = {}
state.watchers = {}
```

E nos módulos:

```lua
state.api.snapshotCurrentProject = function()
	...
end

state.api.applyProjectSnapshot = function(projectSnapshot, command)
	...
end
```

Assim, o topo do chunk teria poucas variáveis locais fixas (`state`, serviços Roblox, constantes principais e algumas forward declarations realmente necessárias), e o restante ficaria em tabelas.

Depois dessa migração, dá para considerar envolver módulos em blocos `do ... end`, mas isso só funciona bem quando as funções compartilhadas já foram exportadas por tabela. Se envolver módulos agora sem exportar dependências, outros arquivos deixam de enxergar funções que hoje são `local`.

## O que eu evitaria

### Evitar mover temporários aleatórios para `state`

Mover variáveis temporárias de dentro de funções para `state.*` pode até reduzir alguns locals em casos específicos, mas não é o melhor primeiro passo.

Riscos:

- polui o estado global do plugin;
- aumenta chance de uma função sobrescrever dado temporário de outra;
- dificulta debug;
- pode não resolver o erro, porque o gargalo está nos `locals` de topo.

### Evitar `require()` ou `dofile()` agora

Separar em múltiplos módulos carregáveis seria limpo em teoria, mas é uma mudança grande no empacotamento do plugin Roblox. Para corrigir esse bug, é mais seguro manter o single-file e reduzir os `locals` de topo.

## Ordem prática de trabalho

1. Rodar `npm.cmd run build:plugin` e confirmar que `src/plugin/Amarillo.lua` reflete `src/plugin-src`.
2. Alterar `90_watchers_loops.lua` para não declarar nenhum `local` de topo.
3. Rebuildar o plugin.
4. Testar no Roblox Studio.
5. Se ainda falhar, converter funções de topo em `80_ui.lua` para `state.uiActions.*`.
6. Depois fazer o mesmo, com mais cuidado, em `40_snapshot_sync.lua` e `50_commands.lua`.
7. Adicionar um check de build/teste que alerte quando o plugin gerado tiver muitos `local`/`local function` de topo.

## Critério de sucesso

O plugin deve:

- compilar e abrir no Roblox Studio sem erro de `local registers`;
- conectar ao daemon;
- aceitar conexão;
- iniciar watchers;
- fazer sync manual Studio -> PC e PC -> Studio;
- fazer patch de script aberto pelo `ScriptEditorService`;
- manter os testes do repo passando.

## Resumo

Minha recomendação é: não começar pela otimização de variáveis temporárias em `40_snapshot_sync.lua` ou `50_commands.lua`.

Comece pelo erro real: o arquivo gerado tem locais de topo demais. Primeiro faça `90_watchers_loops.lua` parar de adicionar `local` no topo. Depois reduza os módulos grandes convertendo funções de topo para tabelas de ações em `state`.
