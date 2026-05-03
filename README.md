# Amarillo

Bridge para Roblox Studio inspirado na arquitetura do Argon.

Este repositorio e o **codigo-fonte da ponte e da extensao do VS Code**. Ele nao deve ser tratado como o workspace Roblox principal de um projeto real.

## Componentes

- `src/daemon/`: daemon HTTP que coordena sessoes, sync e estado do Studio
- `src/mcp-proxy/`: cliente MCP por `stdio` que encaminha tools para o daemon HTTP ja rodando
- `src/plugin/Amarillo.lua`: plugin local do Roblox Studio
- `vscode-extension/`: extensao do VS Code
- `examples/roblox-workspace/`: workspace Roblox dedicado para validacao manual
- `tests/`: testes Node para parser, bootstrap e MCP proxy

## Arquitetura atual

- um unico daemon autoritativo atende o plugin do Studio e a extensao do VS Code;
- o MCP do editor nao sobe um segundo bridge concorrente;
- `Amarillo: Start Bridge` garante o bridge local e escreve/atualiza `.vscode/mcp.json` para falar com o daemon existente via proxy `stdio -> HTTP`;
- `Amarillo: Configure MCP for Workspace` permanece disponivel para regenerar manualmente o `mcp.json` quando necessario;
- a porta padrao do stack inteiro e `8323`.

## Fluxo recomendado para usuarios

1. Abra no VS Code o **workspace Roblox real** do projeto.
2. Rode `Amarillo: Install Roblox Studio Plugin`.
3. Rode `Amarillo: Start Bridge`.
4. No Roblox Studio, abra o plugin `Amarillo` e clique em `Conectar`.
5. Use `Send Files to Studio`, `Receive Files from Studio` e as tools MCP conforme necessario.

## Projetos herdados por place

O Amarillo agora aceita um modelo de `projeto-base + projetos derivados` no mesmo workspace:

- use `abstract: true` em um `.project.json` base para declarar mounts e regras compartilhadas;
- use `extends` nos projetos por place para herdar a base e adicionar apenas as pastas exclusivas;
- a resolucao continua automatica por `placeId`, entao cada reconexao do Studio escolhe o derivado certo sem exigir outro VS Code.

Exemplo resumido:

```json
{
  "name": "Base",
  "abstract": true,
  "tree": {
    "ReplicatedStorage": {
      "$path": "shared/ReplicatedStorage"
    }
  }
}
```

```json
{
  "name": "Lobby",
  "extends": "Base.project.json",
  "placeIds": [123456],
  "tree": {
    "ServerScriptService": {
      "$path": "places/Lobby/ServerScriptService"
    }
  }
}
```

Nesse formato, a pasta compartilhada entra em todos os places derivados, enquanto cada pasta exclusiva sincroniza apenas no place correspondente.

## Como usar o MCP tool

- Ao rodar `Amarillo: Start Bridge`, a extensao tambem escreve ou atualiza `.vscode/mcp.json` no workspace aberto.
- Se o seu cliente de IA/MCP ja estava aberto, reabra a sessao para ele recarregar os servidores MCP do workspace.
- `Amarillo: Configure MCP for Workspace` continua util como comando manual de regeneracao ou reparo do `mcp.json`.

Exemplos de pedidos para o cliente de IA:

- `health`
- `list_projects`
- `get_tree`
- `run_code`
- `push_changes`
- `pull_changes`

## Fluxo recomendado para desenvolvimento deste repo

Use o workspace dedicado em `examples/roblox-workspace/`.

A raiz deste repositorio nao carrega um `.project.json` de Rojo de proposito. Para usar sourcemap do Luau, validar sync Roblox ou testar MCP como usuario final, abra `examples/roblox-workspace/` ou o workspace Roblox real do seu jogo.

Se voce usa `aftman`, rode `aftman install` na raiz deste repositorio para instalar o `rojo` declarado em `aftman.toml`.

Os arquivos versionados em `.vscode/` deste repositorio apontam para esse exemplo:

- `.vscode/tasks.json`
- `.vscode/extensions.json`

Arquivos locais/gerados ficam fora do Git para evitar publicar caminhos absolutos, configuracoes do seu workspace real ou pacotes buildados:

- `.pluginroblox.json` e criado por usuario; use `.pluginroblox.example.json` como base quando precisar.
- `.vscode/mcp.json` e `.vscode/settings.json` sao gerados/configurados localmente pela extensao.
- `sourcemap.json`, `debug.log`, `RELATORIO_*.md`, `dist/` e `*.vsix` sao artefatos de diagnostico/build.

Tasks locais disponiveis:

- `Amarillo Dev: Install Roblox Plugin`
- `Amarillo Dev: Start Example Daemon`
- `Amarillo Dev: Healthcheck Example`

## MCP

Tools disponiveis:

- leitura e sync: `health`, `list_projects`, `set_active_project`, `get_tree`, `get_selection`, `inspect_instance`, `run_code`, `push_changes`, `pull_changes`, `start_playtest`, `stop_playtest`
- introspeccao: `get_properties`, `get_descendants`, `search_instances`, `get_services`, `get_instance_info`, `get_output_log`
- operacoes destrutivas: `modify_property`, `create_instance`, `delete_instance`

## Testes

```powershell
node --test
```

## Gerar VSIX

O pacote da extensao nao e versionado. Gere localmente quando precisar publicar ou instalar uma build:

```powershell
npm run package:vsix
```

O arquivo final sera criado em `dist/`.

## Status validado

- `node --test` deve permanecer verde;
- o daemon HTTP responde em `127.0.0.1:8323`;
- o MCP responde a `initialize` e `tools/list`;
- a validacao final de `push/pull`, `run_code` e introspeccao ainda depende de uma sessao real do Roblox Studio conectada.

## Observacoes

- O projeto continua `Windows-first`.
- O plugin do Studio permanece em arquivo unico para facilitar instalacao e reload.
- O sync de propriedades segue extensivel para novas classNames e tipos serializados.
