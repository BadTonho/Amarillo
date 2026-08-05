<div align="center">
  <img src="assets/icon.png" alt="Amarillo Logo" width="140" />

  # ⚡ Amarillo — Ponte entre Roblox Studio & VS Code

  **Uma ponte bidirecional moderna, veloz e inteligente, inspirada na arquitetura do Argon.**
  *Projetado com TypeScript, Luau e ferramentas nativas MCP para fluxos de trabalho avançados com Inteligência Artificial e IDE no Roblox Studio.*

  [![Release](https://img.shields.io/badge/VERS%C3%83O%20OFICIAL-V1.2.0-00E599?style=for-the-badge&logo=github&logoColor=white)](https://github.com/)
  [![Node.js](https://img.shields.io/badge/RUNTIME-NODE%2022+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![TypeScript & Luau](https://img.shields.io/badge/LINGUAGEM-TYPESCRIPT%20%26%20LUAU-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  <br />
  [![Roblox Studio](https://img.shields.io/badge/PONTE-ROBLOX%20STUDIO-00A2FF?style=for-the-badge&logo=roblox&logoColor=white)](https://create.roblox.com/)
  [![Plataforma](https://img.shields.io/badge/PLATAFORMA-WINDOWS%2010%20%7C%2011-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
  [![Licença: MIT](https://img.shields.io/badge/LICEN%C3%87A-MIT-8A2BE2?style=for-the-badge&logo=open-source-initiative&logoColor=white)](LICENSE)

  <p align="center">
    <a href="README.md">🇺🇸 English</a> | <b>🇧🇷 Português (Brasil)</b> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.zh-CN.md">🇨🇳 简体中文</a>
  </p>
</div>
<br />

Este repositório contém o **código-fonte da ponte (daemon) e da extensão para o VS Code**. Ele não deve ser tratado como a pasta de trabalho principal para o desenvolvimento de um jogo real em Roblox Studio.

## Componentes

- `src/daemon/` e `src/mcp-proxy/`: código-fonte canônico em TypeScript do daemon HTTP e do proxy MCP, responsáveis pela inicialização dos serviços centrais. Os arquivos `.js` gerados nessas pastas são artefatos de build.
- `vscode-extension-src/`: código-fonte canônico em TypeScript para a extensão do VS Code.
- `src/plugin-src/`: módulos canônicos em Luau ordenados para o plugin do Roblox Studio, contendo rotinas avançadas de bootstrap e gerenciamento de status.
- `src/plugin/Amarillo.lua`: arquivo único compilado e commitado para o plugin do Roblox Studio, lido pelo Studio, pela extensão e durante o empacotamento do VSIX.
- `src/daemon/**/*.js`, `src/mcp-proxy/**/*.js`, `vscode-extension/*.js`, `tests/*.js` e `scripts/*.js`: artefatos JavaScript gerados pela compilação do TypeScript.
- `tests/`: testes canônicos em TypeScript que validam a análise de projetos, inicialização (bootstrap), diagnósticos, empacotamento VSIX e o comportamento do proxy MCP.

## Arquitetura Atual

- Um único daemon principal atende tanto o plugin do Roblox Studio quanto a extensão do VS Code com serviços essenciais completos.
- O servidor MCP integrado não inicia uma segunda ponte paralela ou conflitante.
- O comando `Amarillo: Start Bridge` garante que a ponte local está operando e escreve ou atualiza os arquivos de configuração MCP portáteis na pasta de trabalho, para que assistentes de Inteligência Artificial conversem com o daemon através do proxy `stdio -> HTTP`.
- Os comandos `Amarillo: Configure MCP for Workspace` e `Amarillo: Configure Codex MCP` regeram os arquivos de configuração do MCP e tentam registrá-los no terminal com a CLI do Codex.
- Sincronização granular orientada aos Locais do jogo (Places) com validação de montagem (*sync mounts*), garantindo operações seguras e evitando perda de dados em operações destrutivas.
- Normalização de snapshots e padronização de propriedades garantem uma verificação de sincronização estável para todas as classes de instâncias do Roblox.
- A porta de rede padrão para toda a pilha de aplicação é **`8323`** (vinculada com isolamento estrito em loopback `127.0.0.1`).

## Fluxo de Trabalho Recomendado para o Usuário

1. Abra a pasta do seu projeto real de Roblox no VS Code.
2. Execute no painel de comandos do VS Code: `Amarillo: Install Roblox Studio Plugin`.
3. Em seguida, rode: `Amarillo: Start Bridge`.
4. No Roblox Studio, abra a janela do plugin `Amarillo` e clique no botão **Connect** (*Conectar*).
5. Use os botões `Send Files to Studio`, `Receive Files from Studio` ou interaja com ferramentas de IA via MCP conforme necessário.

### Recursos do Plugin

O plugin Amarillo é capaz de:

**Funcionalidades Centrais:**
- Sincronização de arquivos em tempo real (bidirecional) entre o VS Code e o Roblox Studio.
- Monitoramento do status da conexão e diagnósticos rápidos na própria interface.
- Suporte para projetos de Locais Múltiplos (*multi-place*) com detecção automática do local via `placeId`.

**Diferenciais de Sincronização e Segurança:**
- **Monitoramento de Sincronização de Locais**: Rastreia o progresso da sincronização de múltiplos locais simultaneamente.
- **Validação de Montagem de Sincronização (*Sync Mount*)**: Mutações e deleções estruturais possuem checagem prévia para evitar perda acidental de assets inativos do jogo.
- **Alvos de Sincronização (*Workspace Sync Targets*)**: Gerenciamento detalhado de quais ramificações de pastas da árvore local serão copiadas para o Studio.
- **Normalização de Snapshots**: Uniformiza as propriedades da árvore para validação à prova de ruídos.
- **Validação do Duplo Hash (*Dual-Hashing Protection*)**: Compara conjuntamente o hash semântico das propriedades e o hash bruto de conteúdo SHA-1 da instância, impedindo que mutações acidentais de parâmetros visuais padrão do Roblox (como `ZIndex`) gerem gravações desnecessárias no seu SSD/HD.
- **Alternância sem Perdas (*Zero-Loss Mount Toggling*)**: Memoriza os caminhos das pastas de sincronização personalizadas nas propriedades de metadados, para que você não perca configurações ao desligar e reativar rotas de sync.
- **Proteção contra Salto de Diretório (*Path Traversal Protection*)**: Rejeita segmentos de caminhos de arquivos mal-intencionados (ex: `..` ou tentativas de escapar da raiz) durante modificações.
- **Higienização de Snapshots**: Escapa automaticamente nomes de instâncias incompatíveis com o Windows (como `..\outside`) em nomes de arquivos seguros na pasta do PC (`__outside`), salvando o nome original intacto no arquivo de metadados `init.meta.json`.
- **Daemon Local Blindado (CORS Strict)**: O servidor implementa políticas rígidas de CORS em loopback (`127.0.0.1`), rejeitando solicitações falsas de sites abertos no seu navegador para rotas administrativas da API ou comandos MCP.
- **Compressão de Payloads (Brotli/Gzip)**: Comprime o tráfego HTTP de alta densidade usando algoritmos avançados, permitindo que árvores imensas com dezenas de milhares de instâncias trafeguem entre o Studio e o disco de forma instantânea.
- **Deduplicação Inteligente de Erros**: Evita o excesso de logs e travamentos gerados por erros repetitivos no console, consolidando alertas com assinaturas unificadas de rastreamento.

## Projetos Derivados Baseados em Locais (*Places*)

O Amarillo suporta uma estrutura inovadora de `projeto base + projetos derivados` na mesma pasta de trabalho raiz do VS Code, operando via detecção automática:
- Utilize `abstract: true` no seu arquivo base `.project.json` para declarar pastas e regras universais.
- Utilize a propriedade `extends` em arquivos `.project.json` dedicados a locais específicos, de modo que herdem a configuração da base e declarem apenas diretórios exclusivos daquele sub-local.
- A alternância ocorre por `placeId` de forma autônoma: ao mudar a janela ativa do estúdio, o plugin local conecta ao projeto derivado perfeito sem exigir reabertura do seu VS Code ou terminal de IA!
- Cada subprojeto de local derivado tem seus próprios filtros e alvos de sincronização customizados.

Exemplo Rápido:

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

Com este formato, a pasta compartilhada entra diretamente na estrutura de todos os locais herdados, enquanto que scripts restritos (ex: `ServerScriptService` do Lobby) trafegam exclusivamente dentro de suas janelas correspondentes.

## Integração e Comandos MCP (Model Context Protocol)

O Amarillo é equipado nativamente com o protocolo MCP completo, permitindo que IAs (Codex, Claude, Cursor) e automatizadores examinem o seu Roblox Studio ao vivo.

**Instruções de Inicialização:**
- Rodar o comando `Amarillo: Start Bridge` no VS Code também constrói e atualiza automaticamente os arquivos `.vscode/mcp.json` e `.vscode/amarillo-mcp-bootstrap.cjs` no espaço de trabalho.
- Credenciais e tokens sensíveis à segurança ficam restritos a `.amarillo/mcp-local.json` (este arquivo **nunca** deve ser incluído nos commits do Git).
- Caso o seu cliente de Inteligência Artificial ou assistente MCP já estivesse executando antes da ativação, reinicie a sessão dele para que carregue o servidor do Amarillo em `.vscode/mcp.json`.
- Os comandos `Amarillo: Configure MCP for Workspace` e `Amarillo: Configure Codex MCP` efetuam testes acionando a linha de comando do Codex diretamente, além de fornecerem o comando formatado para colar caso você prefira registrá-lo manualmente no terminal.

**Lista Completa de Comandos MCP do Amarillo (20 Ferramentas):**

*Sincronização e Operações Centrais:*
- `health` - Verifica a integridade e saúde da ponte entre VS Code e Roblox Studio.
- `list_projects` - Lista os arquivos de configuração dos projetos Roblox da área de trabalho.
- `set_active_project` - Altera o projeto de sincronização atualmente em foco.
- `connect_session` - Força e cria uma sessão direta sem depender de convite e aperto de mão (*handshake*).
- `get_tree` - Obtém a estrutura hierárquica e arvore do local conectado no Roblox Studio.
- `get_selection` - Retorna quais instâncias estão sendo selecionadas no editor pelo desenvolvedor.
- `push_changes` - Envia código e alterações das pastas no seu PC diretamente para dentro do Studio.
- `pull_changes` - Captura todas as edições feitas nas árvores e telas do Studio para salvar no seu PC.
- `start_playtest` - Inicia remotamente o teste de jogo (*Playtest*) no Studio sem precisar clicar com o mouse na tela.
- `stop_playtest` - Encerra o teste de jogo (*Playtest*) ativo.

*Inspeção, Diagnósticos e Pesquisa:*
- `inspect_instance` - Detalha a árvore genealógica, propriedades e metadados de uma instância do jogo.
- `get_properties` - Retorna todas as propriedades legíveis, scripts associados ou visibilidade de um item.
- `get_descendants` - Pesquisa e retorna instâncias descendentes com possibilidade de filtros de classe.
- `search_instances` - Localiza rapidamente objetos pela nomenclatura exata de nome ou `ClassName`.
- `get_services` - Lista quais serviços oficiais do motor do Roblox Studio estão disponíveis ou modificados.
- `get_instance_info` - Entrega uma análise documental completa de uma instância específica.
- `get_output_log` - Captura e retorna os últimos logs impressos (erros, avisos, prints de Luau) na janela de Saída (*Output*) do Studio!

*Operações Privilegiadas (Possuem Travas de Segurança no Studio):*
- `run_code` - Executa um código ou script Luau arbitrário em tempo real dentro da sessão do Studio. (Requer confirmação manual de segurança clicando em *Accept* no painel do Studio por motivo de segurança defensiva).
- `modify_property` - Muta propriedades ou atributos personalizados em instâncias no seu jogo.
- `create_instance` - Constrói novas instâncias dinamicamente pelo código.
- `delete_instance` - Remove e destrói instâncias do cenário de estúdio ativo.
- `insert_model` - Importa e introduz modelos oficiais diretamente da galeria do Mercado do Roblox!

## Como Desenvolver Este Repositório localmente

Utilize a área de trabalho dedicada de exemplo localizada em `examples/roblox-workspace/`.

O motor Node.js e o código-fonte da extensão para o VS Code são escritos puramente em TypeScript:
- As pastas `src/daemon/**/*.ts` e `src/mcp-proxy/**/*.ts` compilam para arquivos `.js` dentro das próprias hierarquias originais.
- A pasta `vscode-extension-src/` compila em fecho para dentro da `vscode-extension/`.
- `scripts/*.ts` é compilado para `scripts/*.js`.
- `tests/*.ts` é compilado para `tests/*.js`.

O plugin para Roblox Studio é inteiramente construído a partir de arquivos numerados fragmentados em Luau na pasta `src/plugin-src/*.lua`, que posteriormente são combinados na montagem única oficial em `src/plugin/Amarillo.lua`. O motor do Roblox Studio lê exclusivamente esse arquivo concatenado; nunca o modifique à mão!

Sempre acione `npm run build` após fazer modificações de desenvolvimento nos scripts em TypeScript do motor do daemon, da extensão, ou nas frações Luau do seu plugin do Studio. Acione também `npm run build:scripts` caso precise invocar ferramentas manuais da pasta de scripts em CLI por linha de comando. Os arquivos `.js` permanecem em pastas rastreadas localmente pelos processos para evitar incompatibilidade do Studio ou depuração, mas não devem ser commitados no Git ou modificados individualmente de forma manual.

Comandos para desenvolvimento:

- `npm.cmd run typecheck`: faz a verificação estrita de tipagem no runtime, extensão, contratos TypeScript, scripts e suíte de teste.
- `npm.cmd run build:plugin`: monta e atualiza instantaneamente o arquivo único `src/plugin/Amarillo.lua` com base no painel de organização de `src/plugin-src/manifest.json`.
- `npm.cmd run check`: faz o build integral de códigos JavaScript gerados acompanhados por diagnósticos via `node --check`.
- `npm.cmd run check:sources`: certifica-se com precisão de que arquivos TypeScript possuindo contrapartes compiladas equivalentes do JavaScript mantenham-se separados das rotinas de rastreio de código de origem.
- `npm.cmd test`: aciona a compilação completa dos scripts gerados exigidos pelo ambiente de testes e na sequência executa o painel unificado via `node --test` (todos os 295 testes oficiais).
- `npm.cmd run diagnose:mcp -- --workspace .`: escanea a disponibilidade da porta de rede do daemon, validações das chaves seletivas criptografadas entre a extensão do VS Code e os cabecistas fallbacks no serviço, catálogos MCP ao vivo e exames de Doctor de conectividade!
- `npm.cmd run clean:generated`: limpa e extermima todos os códigos provisórios compilados de extensões `.js` ignoradas pelo repositório oficial na raiz dos programas e testes!

A raiz oficial deste repositório intencionalmente ignora carregamentos de arquivos base Rojo (`.project.json`). Se você pretende importar sourcemaps originais em Luau para seus scripts de depuração, atestar o funcionamento de pontes ou usar o sistema como cliente real final com assistente de IA, abra o diretório modelo preservado para esse fim em `examples/roblox-workspace/` (ou simplesmente a pasta verdadeira com seu jogo!).

Caso desfrute do utilitário `aftman`, acione `aftman install` no terminal dentro do diretório do projeto para autoinstalar a versão oficial parametrizada do compilador `rojo` listada diretamente em `aftman.toml`.

Os arquivos autorizados sob monitoramento dentro de `.vscode/` conectam-se de forma direta com o nosso cenário modelo da pasta `examples/roblox-workspace/`:

- `.vscode/tasks.json`
- `.vscode/extensions.json`

Arquivos com credenciais sensíveis de sistema Windows ou com diretórios dinâmicos do PC não devem nunca compor envios públicos ou commits de seu Git, blindando a privacidade de chaves provisórias criptografadas, sessões, caches temporários ou pacotes construídos por IDE:

- `.pluginroblox.json` é um diretório particular dinâmico para seu usuário; clone ou inspecione a variante limpa em `.pluginroblox.example.json` se houver necessidade de ter um modelo manual customizado.
- `.vscode/mcp.json` e `.vscode/amarillo-mcp-bootstrap.cjs` constituem-se arquivos sem vínculos privativos, podendo compor tranquilamente com repositórios colaborativos compartilhados de seus projetos!
- `.amarillo/mcp-local.json` concentra tokens sigilosos com a assinatura bridge token oficial de sua máquina e caminhos específicos de instalação do VS Code; guarde-os sob sigilo ignorando da sua lista do Git de envio!
- `.vscode/settings.json` pode sofrer alterações de ambiente criadas dinamicamente localizadas e ajustadas diretamente pela sua própria extensão ativa durante uso livre no dia a dia do estúdio.
- `sourcemap.json`, `debug.log`, relatórios `.md` automáticos do tipo `REPORT_*.md`, repositório exportado de pacotes `dist/`, e binários instaladores no padrão `*.vsix` enquadram-se meramente como dados passageiros gerados do zero pela máquina e do motor do Node.js.

Tarefas do VS Code pré-cadastradas no terminal local para auxiliar desenvolvedores do código-fonte:

- `Amarillo Dev: Install Roblox Plugin`
- `Amarillo Dev: Start Example Daemon`
- `Amarillo Dev: Healthcheck Example`

## Testes Automatizados

```powershell
node --test
```
*(Executa a suíte canônica contendo 295 testes rápidos na sua máquina Windows).*

## Gerando e Compilando Instaladores (.VSIX)

O arquivo compilado final do instalador para o Visual Studio Code nunca é mantido no GitHub de forma estática para poupar peso e garantir autenticidade contínua no código fonte. Você pode criar o seu instalador com este único comando:

```powershell
npm run package:vsix
```

O arquivo no formato `.vsix` será exportado prontamente para dentro da sua pasta `dist/`. O script oficial que prepara esse binário passa por checagem criteriosa: importa exclusivamente bibliotecas empacotadas limpas em JS, bloqueia a criação do VSIX de forma imperativa caso localize caminhos particulares estáticos típicos de desenvolvedores independentes (ex: `C:\Users\...`) e descarta binários incompatíveis com nosso fluxo estrito contendo arquivos do tipo `rbx-studio-mcp.exe`.

## Checklist de Confiabilidade da Aplicação

- Os 295 casos do suíte via `node --test` seguem rodando em verde com aprovação de 100%.
- O serviço do Daemon HTTP responde sem problemas através do endereço seguro nativo do seu loopback no TCP `127.0.0.1:8323`.
- O interpretador do servidor de inteligência artificial via protocolo MCP responde pontualmente a pacotes formais `initialize` e solicitações dinâmicas à rota `tools/list`.
- Operações com perfil de privilégios sensíveis são mantidas estritamente sob quarentena defensiva, sendo barradas por diagnósticos de queda de saúde ou cobradas do autor através do pop-up modal interativo dentro do Studio exibindo opções expressas entre os botões `Accept` / `Decline` (*Aceitar ou Recusar*).
- Funções avançadas da árvore para envio/recebimento (`push/pull`), execuções abertas de códigos Luau de teste via terminal (`run_code`) ou verificações do log exigirão sempre ter ao menos uma instância oficial do seu aplicativo cliente do Roblox Studio com o plugin do Amarillo aberto, operando em conexão real paralela.

## Notas Técnicas e Diferenciais

- O ecossistema completo de desenvolvimento e compilação preza em ser nativamente `Windows-first`.
- O aplicativo do seu plugin executando no Studio foi concebido na arquitetura de um único script concatenado soberano gerado (via build) para propiciar reloads relêmpago durante sessões ativas do desenvolvedor e simplificar sua instalação física local.
- O mapeamento nativo de conversões bidirecionais de atributos e propriedades é modelado com escalabilidade robusta, possibilitando cadastros rápidos de tipos com suporte completo nas diretrizes atualizadas da API de serialização oficial do Roblox!
- Mecanismos inteligentes de equalização aplicam correções dinâmicas de comparação semântica contra parâmetros nativos omitidos que constituem propriedades primárias padronizadas pela própria engine, eliminando ruídos para certificar comparações precisas por trás das árvores em tela!
- Travas automatizadas contra deleções acidentais operam sobre validações hierárquicas prévias em cenários que acionem exclusões perigosas, blindando com segurança inabalável a salvaguarda íntegra sobre assets paralelos fora do escopo selecionado na sua sincronização ativa.
- Validação simultânea de duplo hash em tela compara assinaturas sintéticas semânticas contra hash analítico puro de conteúdo em SHA-1, eliminando processamento reativo inútil para que seu armazenamento não receba disparos impróprios de disco gerados unicamente em consequência de instâncias cosméticas de janela!
- Higienização cruzada contra caracteres hostis aos diretórios operacionais trata dinamicamente barras invertidas providas pela plataforma (`\`) transformando as representações padronizadamente para o caractere homologado limpo internacional (`/`), zerando desarrumações nos repositórios.
- Regras de filtro para caminhos inversos como `syncback.ignoreNames`, `syncback.ignoreClasses` e `syncback.ignoreProperties` ganham cobertura estendida sendo compreendidas de pronto pelos motores de leitura, transmitidas sem ruídos nas árvores genealógicas filhas e estritamente policiadas nas linhas das bibliotecas que gravam suas edições do Studio diretamente nas pastas locais do sistema.
- Registros detalhados diários sobre diagnósticos de integridade são salvos sequencialmente separáveis através da estrutura limpa `.amarillo/activity/YYYY-MM-DD/`, contemplando relatórios abertos analíticos (`mcp.md`) combinados com registros lineares em formato de consulta JSONL para as chamadas de suas IAs no dia a dia (`mcp.jsonl`).
- Camadas severas de saneamento contra tentativas maliciosas para escalada indevida nas árvores do seu sistema operacional interceptam nomes com perfis atípicos suspeitos (como `..\`) revertendo as strings com caracteres seguros na pasta do disco (ex: `__`) sem comprometer jamais o nome oficial preservado via manifesto JSON, impedindo substituições indevidas na sua rede de pastas Windows e fora dos limites que a sincronização estipular!
- Filtros de segurança avançada contra acessos fraudulentos baseados em requisições CORS abertas isolam as execuções garantindo permissão irrestrita exclusiva puramente a conexões autênticas provenientes diretamente das chamadas originárias do IP do loopback de origem (`localhost`, `127.0.0.1`), mantendo intrusos de navegação web muito longe do controle das portas do seu ambiente estúdios/IA!

## Licença

Este projeto e toda a sua infraestrutura operam livres mediante as diretrizes protocolares permissivas asseguradas pela licença oficial **MIT License**. Para averiguação do documento em sua íntegra acione a leitura no registro anexo em [LICENSE](LICENSE).
