const fs = require('fs');
let c = fs.readFileSync('vscode-extension-src/sidebar-render.ts', 'utf8');
c = c.replace('<div class="eyebrow">Amarillo Bridge</div>', '<div class="eyebrow">Amarillo Bridge v${escapeHtml(status.version || "unknown")}</div>');
fs.writeFileSync('vscode-extension-src/sidebar-render.ts', c);
