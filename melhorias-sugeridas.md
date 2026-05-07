# Melhorias sugeridas

Atualizado em 2026-05-07 apos implementar as blindagens pos-migracao TypeScript.

## Validacoes executadas

- `npm.cmd run typecheck`: agora inclui runtime, extensao, contratos, scripts e testes com `noCheck: false`.
- `npm.cmd run check`: valida build, typecheck e sintaxe dos JS gerados.
- `npm.cmd test`: compila os testes TypeScript para JS gerado antes de executar `node --test`.
- `npm.cmd run package:vsix`: gera o VSIX usando JS compilado.
- `npm.cmd run clean:generated`: remove JS gerado ignorado por Git em runtime, extensao, scripts e testes.

## Itens implementados

### 1. Typecheck completo do runtime/extensao

Status: implementado.

`tsconfig.base.json` usa `noCheck: false`, e `npm run typecheck` roda `typecheck:runtime`, `typecheck:extension`, `typecheck:connection`, `typecheck:scripts` e `typecheck:tests`.

### 2. Wrappers PowerShell em clone limpo

Status: implementado.

`scripts/start-daemon.ps1` e `scripts/run-mcp.ps1` agora rodam `npm.cmd run build:runtime` automaticamente quando o JS gerado necessario nao existe.

### 3. Rotas duplicadas em `src/daemon/app.ts`

Status: implementado.

`handleHttp` ficou com autorizacao, dispatch modular e fallback 404. As rotas duplicadas foram removidas do bloco legado.

### 4. Fonte TypeScript com CommonJS

Status: parcialmente implementado.

O projeto continua emitindo CommonJS por compatibilidade, mas os arquivos agora passam por typecheck real. A conversao completa para `import`/`export` pode ser feita gradualmente sem bloquear a migracao.

### 5. Documentacao apontando para JS gerado

Status: implementado.

`README.md` e `.instructions.md` separam fonte canonica TypeScript de artefatos gerados e orientam build antes de comandos manuais.

### 6. Artefatos gerados reaparecem apos build

Status: implementado.

`npm.cmd run clean:generated` remove os JS gerados de forma segura, validando os roots permitidos antes de apagar.

### 7. Versao raiz do pacote

Status: implementado.

`scripts/sync-version.ts` tambem sincroniza a versao raiz do `package.json` com `amarillo-version.json`.

### 8. `@types/node` e runtime minimo

Status: implementado.

`@types/node` foi alinhado para major 22, compativel com `engines.node >=22.0.0`.

### 9. Texto de diagnostico em PowerShell

Status: revisado.

As mensagens alteradas nesta migracao usam ASCII para evitar novo texto corrompido em PowerShell legado.

## Riscos remanescentes

- Ainda ha CommonJS em fonte TypeScript. Isso e compativel com o VSIX atual, mas a conversao para `import`/`export` pode melhorar inferencia no futuro.
- Os tipos adicionados para runtime/extensao sao amplos por design para concluir a migracao com seguranca; podem ser refinados modulo a modulo.

## Proxima ordem sugerida

1. Refinar tipos amplos para interfaces mais especificas por modulo.
2. Converter CommonJS para `import`/`export` gradualmente, mantendo emissao CommonJS.
3. Adicionar CI em Node 22 para garantir compatibilidade real com o runtime minimo.
