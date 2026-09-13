# Regras do agente

Estas regras valem para todo o repositório.

- Não criar o VSIX automaticamente.
- Antes de rodar `npm.cmd run package:vsix`, confirmar explicitamente com o usuário.
- Mudar a versão toda vez antes de gerar um VSIX.
- Se o VSIX for gerado sem mudar a versão, a versão antiga pode ser sobrescrita ou perdida.
- Para validar mudanças, rodar build e testes; empacotar o VSIX somente com pedido explícito depois do aumento da versão.
- Atualizar o `updatelogs` somente com as alterações do plugin, incluindo código, configurações, comportamento e testes do plugin.
- Não registrar no `updatelogs` alterações de documentação ou de outras partes do projeto que não pertençam ao plugin, salvo pedido explícito.
