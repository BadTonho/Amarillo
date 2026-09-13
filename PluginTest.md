# Prompt de teste de estresse da sincronização disco → Studio

Copie o conteúdo deste arquivo e envie em uma nova conversa, já dentro da pasta do projeto que será testada.

```text
Faça um teste de estresse completo exclusivamente da sincronização do plugin do disco para o Studio neste workspace.

Este é um teste em um projeto separado. Não assuma que o workspace atual é o repositório Amarillo, não use caminhos do projeto anterior e não limite a análise à última alteração ou a uma versão específica.

O ambiente do plugin, Roblox Studio, daemon e bridge será preparado e conectado por mim. Não teste conexão, reconexão, ativação, desativação, inicialização, encerramento ou ciclo de vida do plugin. Se o ambiente não estiver conectado, informe que o teste de sincronização está bloqueado e não investigue esse problema.

Faça todas as criações, alterações, movimentações, renomeações e exclusões somente no disco. Não edite manualmente o Studio durante a carga e não faça um teste de conflito entre Studio e disco. Depois que toda a carga terminar, sincronize e verifique se o Studio corresponde exatamente ao estado esperado no disco.

## Objetivo

Testar 100% do fluxo de sincronização disco→Studio com carga real e repetitiva, encontrando perda ou corrupção de dados, divergências entre o estado final do disco e o Studio, regressões, falhas intermitentes e problemas de desempenho. Não faça apenas uma verificação superficial: crie uma carga de trabalho grande, repita as operações muitas vezes e deixe explícito tudo que não puder ser testado.

## Antes de testar

1. Leia as regras do workspace e os arquivos de configuração existentes.
2. Inspecione a implementação da sincronização, os formatos de arquivo, os mounts, o snapshot, o syncback e os testes existentes.
3. Identifique todos os tipos de dados sincronizados e monte uma matriz de cobertura.
4. Verifique os comandos de teste e os requisitos externos já preparados.
5. Não presuma que um teste existente cobre uma funcionalidade só porque ele passou.

## Escopo obrigatório da sincronização

### Fluxo disco para Studio

- Alterar scripts, metadados, propriedades e atributos no disco e aplicar ao Studio.
- Criar, mover, renomear e remover arquivos dentro dos mounts.
- Testar sincronizações consecutivas, repetidas e interrompidas.
- Confirmar que somente Instances existentes e permitidas são atualizadas quando essa for a regra.
- Confirmar que dados locais inválidos geram erro claro sem corromper o estado anterior.
- Não fazer alterações manuais no Studio durante esses cenários.

### Carga real de arquivos e pastas

- Criar várias pastas em diferentes níveis de profundidade dentro dos mounts.
- Criar muitos arquivos de diferentes tipos e tamanhos dentro dessas pastas.
- Alterar o conteúdo dos arquivos várias vezes e sincronizar cada lote.
- Renomear arquivos e pastas repetidamente.
- Mover arquivos entre pastas, mover pastas inteiras e mover estruturas profundamente aninhadas.
- Copiar estruturas e criar nomes duplicados quando o filesystem e o plugin permitirem.
- Apagar arquivos individualmente, apagar lotes de arquivos, apagar pastas vazias e apagar pastas com descendentes.
- Recriar arquivos e pastas com os mesmos nomes depois de apagar ou mover os originais.
- Misturar criação, alteração, renomeação, movimentação e exclusão na mesma rodada.
- Executar essas operações em dezenas ou centenas de ciclos, aumentando o volume progressivamente.
- Fazer sincronizações após cada lote e também após sequências de operações sem sincronizar.
- Confirmar no disco, depois de cada ciclo, que não existem arquivos fantasmas, duplicados indevidos, metadados órfãos, pastas vazias inesperadas ou dados perdidos.
- Repetir o mesmo cenário com nomes longos, caracteres especiais, nomes parecidos e arquivos grandes dentro de limites seguros.
- Usar um gerador de carga com seed fixa ou registrar todas as operações para que qualquer falha seja reproduzível.

### Models e assets

- Testar `Detect Models` ativado e desativado.
- Confirmar que Models só aparecem em mounts ativos.
- Confirmar que Models em `Workspace` respeitam o estado do mount `Workspace`.
- Verificar descriptors compactos, `modelDescriptor: true` e atributos/propriedades serializáveis.
- Confirmar que o descriptor nunca contém a hierarquia completa ou conteúdo recursivo desnecessário.
- Confirmar preservação de Models opacos antigos sem `modelDescriptor`.
- Testar Models com MeshParts, texturas, assets, Source e conteúdo binário sem baixá-los ou corrompê-los.
- Confirmar que descriptors nunca criam, removem ou limpam o Model ou seus filhos.

### Integridade, compatibilidade e segurança

- Testar árvores pequenas, grandes e profundamente aninhadas.
- Testar muitos filhos, muitos descendentes, nomes duplicados e nomes inválidos.
- Testar propriedades e atributos ausentes, inválidos, inesperados e muito grandes.
- Testar metadados antigos, ausentes, incompletos, corrompidos e incompatíveis.
- Testar arquivos desconhecidos e assets opacos dentro dos mounts.
- Testar regras de ignore, `syncback`, mounts duplicados e projetos derivados.
- Testar caminhos malformados e tentativas de sair do mount.
- Confirmar que arquivos e Instances fora do mount ou do projeto não são alterados.
- Verificar que uma falha parcial não deixa o projeto em estado inconsistente.

### Interrupções e repetição

- Alterar muitos arquivos rapidamente no disco antes de sincronizar.
- Executar sincronizações consecutivas e simultâneas somente com alterações originadas no disco, quando suportado.
- Interromper operações no meio e repetir a sincronização.
- Verificar idempotência: repetir a mesma operação não deve duplicar, apagar ou alterar dados indevidamente.
- Não criar nem testar conflitos causados por alterações simultâneas no Studio.

### Volume e resistência

- Usar o maior número seguro de Instances, descendentes, propriedades, pastas e arquivos possível.
- Executar uma rodada pequena, uma rodada média e uma rodada pesada, aumentando o número de operações em cada rodada.
- Repetir snapshots e sincronizações por tempo suficiente para revelar vazamentos, degradação ou acúmulo de estado antigo.
- Executar várias sequências de criação, alteração, movimentação e exclusão sem pausa artificial entre as operações.
- Testar alterações rápidas em muitos objetos, pastas e arquivos.
- Manter todas as alterações da carga no disco.
- Comparar, somente ao final da carga, o estado esperado no disco com o estado real no Studio usando uma lista de operações ou manifesto de referência.
- Medir tempo por lote, throughput, uso de memória, CPU, crescimento de arquivos e tamanho dos payloads.
- Registrar a operação exata que precedeu cada divergência ou falha.
- Interromper cenários que possam causar perda de dados e preservar todas as evidências.

## Execução

1. Prepare uma cópia ou fixture temporária do projeto para que operações de criação e exclusão sejam seguras.
2. Registre o estado inicial e crie um manifesto do estado esperado.
3. Execute os testes unitários, de integração, end-to-end e de sincronização existentes.
4. Crie e execute no disco uma carga real de pastas e arquivos com operações aleatórias e também com sequências determinísticas.
5. Execute somente o fluxo disco→Studio nas cargas pequena, média e pesada.
6. Adicione testes temporários ou permanentes para cenários de sincronização sem cobertura quando necessário.
7. Execute lint, typecheck, build e verificações de fontes disponíveis.
8. Rode cada grupo de sincronização mais de uma vez para detectar falhas intermitentes.
9. Durante a carga, valide o manifesto somente contra o disco; não altere nem confira manualmente o Studio.
10. Depois que toda a carga terminar, compare o manifesto final do disco com o Studio, incluindo conteúdo, caminhos, metadados e quantidade de objetos.
11. Registre comandos, seed, operações, duração, ambiente, logs e condições de cada falha.
12. Não esconda falhas, não marque testes ignorados como aprovados e não trate cobertura parcial como aprovação total.

## Restrições

- Não testar conexão, reconexão, ativação, desativação ou ciclo de vida do plugin.
- Não fazer alterações manuais no Studio durante o teste.
- Não testar o fluxo Studio→disco nem conflitos entre alterações do Studio e do disco.
- Não gerar, publicar ou instalar VSIX automaticamente.
- Não alterar o código para esconder uma falha.
- Não corrigir bugs sem minha autorização explícita; primeiro apresente a evidência.
- Não apagar dados reais do projeto. Use fixtures, cópias ou diretórios temporários para cenários destrutivos.
- Documentação não é prioridade, exceto quando necessária para testar a sincronização.

## Relatório final

Entregue um relatório objetivo com:

1. Ambiente de sincronização testado e limitações.
2. Matriz de cobertura das operações feitas no disco e aplicadas ao Studio.
3. Todos os comandos executados e resultados.
4. Quantidade de testes aprovados, falhos, ignorados e não executáveis.
5. Bugs encontrados, classificados como crítico, alto, médio ou baixo.
6. Para cada bug: passos de reprodução, resultado esperado, resultado real, logs, causa provável e arquivo/linha quando possível.
7. Falhas intermitentes e métricas de estresse observadas.
8. Dados ou cenários de sincronização que não puderam ser testados.
9. Riscos de perda, corrupção ou divergência de dados.
10. Comparação final entre o estado esperado no disco e o estado encontrado no Studio.
11. Veredito da sincronização: aprovada, aprovada com ressalvas ou reprovada.

Não diga apenas que os testes passaram. Mostre o que foi sincronizado, o que não foi testado e quais problemas ainda existem.
```
