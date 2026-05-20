# Plano de Segurança - Sincronização Roblox Studio & VS Code

## Problema Identificado
- Sincronização bidirecional apaga arquivos criados em um lado
- O arquivo `.init` foi perdido após sync com Roblox Studio
- Necessária recuperação via git revert

## Estratégias de Prevenção

### 1. **Estrutura de Pastas Separadas** ⭐ (RECOMENDADO)
Manter arquivos customizados em pastas específicas que não sincronizam com Roblox Studio:

```
roblox-workspace/
├── src/                    # Sincronizado com Roblox Studio
│   ├── shared/
│   ├── server/
│   └── client/
├── custom/                 # NÃO sincronizado
│   ├── .init              # Arquivo seguro aqui
│   ├── helpers.lua
│   └── utilities/
└── config/                 # NÃO sincronizado
    └── sync-config.json
```

**Vantagem**: Separação clara de responsabilidades

### 2. **Configurar .gitignore Inteligente**
```gitignore
# Arquivos sincronizados com Roblox Studio (ignore mudanças)
roblox-workspace/src/**/*.lua

# Mas RASTREIE arquivos customizados
!roblox-workspace/custom/
!roblox-workspace/custom/**/*.lua
!roblox-workspace/.init
```

### 3. **Script de Sincronização Segura**
Criar script que:
- Faz backup dos arquivos customizados antes de sincronizar
- Restaura após o sync
- Avisa sobre conflitos

```powershell
# scripts/safe-sync.ps1
param([string]$source, [string]$dest)

# Backup arquivos customizados
$customFiles = @('.init', 'custom/*')
$backup = "backups/$(Get-Date -Format 'yyyyMMdd_HHmmss')"

foreach ($file in $customFiles) {
    Copy-Item $file $backup -Recurse -ErrorAction SilentlyContinue
}

# Executar sincronização
Write-Host "Sincronizando arquivos do Roblox Studio..."
# seu comando de sync aqui

# Verificar se arquivos customizados existem ainda
foreach ($file in $customFiles) {
    if (-not (Test-Path $file)) {
        Copy-Item "$backup/$file" $file -Recurse
        Write-Host "⚠️  Restaurado: $file"
    }
}
```

### 4. **Git Hooks - Auto-Proteção**
Criar hook pré-commit que previne perda de arquivos críticos:

```bash
# .git/hooks/pre-commit
#!/bin/bash

CRITICAL_FILES=('.init' 'custom/.gitkeep')

for file in "${CRITICAL_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "❌ ERRO: Arquivo crítico faltando: $file"
        echo "Abortando commit. Restaure o arquivo e tente novamente."
        exit 1
    fi
done
```

### 5. **Commit Message Pattern**
Usar prefixos no Git para rastrear sincronizações:

```
git commit -m "SYNC: Update Roblox Studio files" 
git commit -m "CUSTOM: Add new .init file"
git commit -m "MERGE: Reconcile sync conflicts"
```

### 6. **Verificação Antes/Depois de Sync**
Checklist antes de sincronizar:

```powershell
# scripts/pre-sync-check.ps1
Write-Host "🔍 Verificando arquivos críticos..."

$criticalFiles = @('.init', 'custom/*', 'config/*')
$missingFiles = @()

foreach ($file in $criticalFiles) {
    if (-not (Test-Path $file)) {
        $missingFiles += $file
    }
}

if ($missingFiles.Count -gt 0) {
    Write-Host "⚠️  Arquivos a sincronizar que podem ser perdidos:"
    $missingFiles | ForEach-Object { Write-Host "   - $_" }
    $response = Read-Host "Continuar? (s/n)"
    if ($response -ne 's') { exit 1 }
}

Write-Host "✅ Verificação concluída. Prosseguindo com sync..."
```

### 7. **Estrutura de Ramificações Git**
- `main`: Código sincronizado com Roblox Studio
- `custom`: Arquivos customizados do VS Code
- `merge/`: Branch para resolver conflitos de sincronização

```
main ─────────────────────────────
      ↖ merge ─────────────────────
        (sincroniza com custom)
      
custom ────────────────────────────
       (mantém .init e helpers)
```

## Checklist de Implementação

- [ ] Criar estrutura `custom/` e `config/` separadas
- [ ] Atualizar `.gitignore` com padrões seguros
- [ ] Criar script `safe-sync.ps1`
- [ ] Criar script `pre-sync-check.ps1`
- [ ] Configurar git hooks (pre-commit)
- [ ] Documentar workflow de sincronização
- [ ] Treinar para usar `safe-sync.ps1` em vez de sync manual
- [ ] Mover `.init` para pasta `custom/`

## Workflow Recomendado

1. **Antes de sincronizar**:
   ```powershell
   .\scripts\pre-sync-check.ps1
   ```

2. **Sincronizar com segurança**:
   ```powershell
   .\scripts\safe-sync.ps1
   ```

3. **Verificar mudanças**:
   ```powershell
   git status
   git diff
   ```

4. **Commitar corretamente**:
   ```powershell
   git commit -m "SYNC: Update Roblox Studio files"
   ```

## Ferramentas Auxiliares

- **Git LFS**: Para arquivos binários grandes do Roblox
- **Pre-commit hooks**: Verificar integridade antes de commits
- **Backup automático**: Usar scripts agendados no Windows Task Scheduler

---

**Última atualização**: 20/05/2026
**Status**: Plano ativo - implementar conforme prioridade
