"use strict";

// CSS used by the Amarillo sidebar webview.

const SIDEBAR_CSS = `
      :root {
        --panel-bg: var(--vscode-sideBar-background, #1f1f1f);
        --panel-bg-alt: var(--vscode-editor-background, #252526);
        --surface: var(--vscode-input-background, #2d2d30);
        --surface-strong: var(--vscode-editorWidget-background, #252526);
        --border: var(--vscode-panel-border, #3c3c3c);
        --foreground: var(--vscode-foreground, #cccccc);
        --muted: var(--vscode-descriptionForeground, #9da5b4);
        --button-border: var(--vscode-button-border, transparent);
        --tone-success: var(--vscode-charts-green, #3fb950);
        --tone-warning: var(--vscode-charts-yellow, #d29922);
        --tone-danger: var(--vscode-charts-red, #f85149);
        --tone-info: var(--vscode-textLink-foreground, #58a6ff);
        --tone-neutral: var(--vscode-descriptionForeground, #8b949e);
        --tone-success-bg: rgba(63, 185, 80, 0.14);
        --tone-warning-bg: rgba(210, 153, 34, 0.16);
        --tone-danger-bg: rgba(248, 81, 73, 0.15);
        --tone-info-bg: rgba(88, 166, 255, 0.14);
        --tone-neutral-bg: rgba(139, 148, 158, 0.13);
        --shadow: 0 8px 18px rgba(0, 0, 0, 0.14);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 14px;
        color: var(--foreground);
        background: linear-gradient(180deg, var(--panel-bg-alt) 0%, var(--panel-bg) 100%);
        font-family: var(--vscode-font-family);
      }

      .shell {
        display: grid;
        gap: 12px;
        max-width: 520px;
        margin: 0 auto;
      }

      .card {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 14px;
        background: var(--surface-strong);
        box-shadow: var(--shadow);
        text-align: center;
      }

      .hero {
        padding: 16px;
      }

      .section-heading {
        display: grid;
        justify-items: center;
        gap: 8px;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0;
      }

      h2,
      h3 {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      .eyebrow,
      .hero-meta,
      .section-heading p,
      .message,
      .fact-label,
      .footer {
        color: var(--muted);
      }

      .eyebrow {
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      .hero-meta {
        margin-top: 12px;
        display: grid;
        gap: 8px;
        font-size: 12px;
      }

      .meta-row {
        display: grid;
        justify-items: center;
        gap: 3px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
      }

      .meta-row span {
        color: var(--muted);
      }

      .meta-row strong {
        color: var(--foreground);
        font-size: 12px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        max-width: 100%;
        border: 1px solid currentColor;
        border-radius: 8px;
        padding: 6px 9px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        overflow-wrap: anywhere;
      }

      .badge::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: currentColor;
        flex: 0 0 auto;
      }

      .tone-success {
        color: var(--tone-success);
      }

      .tone-warning {
        color: var(--tone-warning);
      }

      .tone-danger {
        color: var(--tone-danger);
      }

      .tone-info {
        color: var(--tone-info);
      }

      .tone-neutral {
        color: var(--tone-neutral);
      }

      .tone-border-success {
        border-color: var(--tone-success);
        box-shadow: inset 0 4px 0 var(--tone-success), var(--shadow);
      }

      .tone-border-warning {
        border-color: var(--tone-warning);
        box-shadow: inset 0 4px 0 var(--tone-warning), var(--shadow);
      }

      .tone-border-danger {
        border-color: var(--tone-danger);
        box-shadow: inset 0 4px 0 var(--tone-danger), var(--shadow);
      }

      .tone-border-info {
        border-color: var(--tone-info);
        box-shadow: inset 0 4px 0 var(--tone-info), var(--shadow);
      }

      .tone-border-neutral {
        border-color: var(--tone-neutral);
        box-shadow: inset 0 4px 0 var(--tone-neutral), var(--shadow);
      }

      .badge.tone-success,
      .fact.tone-success {
        background: var(--tone-success-bg);
      }

      .badge.tone-warning,
      .fact.tone-warning {
        background: var(--tone-warning-bg);
      }

      .badge.tone-danger,
      .fact.tone-danger {
        background: var(--tone-danger-bg);
      }

      .badge.tone-info,
      .fact.tone-info {
        background: var(--tone-info-bg);
      }

      .badge.tone-neutral,
      .fact.tone-neutral {
        background: var(--tone-neutral-bg);
      }

      .notes {
        margin-top: 12px;
        display: grid;
        gap: 7px;
        font-size: 12px;
      }

      .session-copy {
        display: grid;
        gap: 8px;
      }

      .message {
        font-size: 12px;
        line-height: 1.45;
      }

      .facts-grid,
      .actions-grid {
        display: grid;
        gap: 8px;
      }

      .facts-grid {
        margin-top: 12px;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      }

      .fact {
        padding: 10px;
        border-radius: 8px;
        border: 1px solid currentColor;
        display: grid;
        gap: 4px;
        justify-items: center;
        min-width: 0;
      }

      .fact-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      .fact-value {
        font-size: 12px;
        font-weight: 600;
        word-break: break-word;
      }

      .actions-grid {
        margin-top: 12px;
        grid-template-columns: repeat(auto-fit, minmax(126px, 1fr));
      }

      .actions-grid.compact {
        margin-top: 10px;
      }

      .action {
        appearance: none;
        min-height: 38px;
        border: 1px solid var(--button-border);
        border-radius: 8px;
        padding: 10px 12px;
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow-wrap: anywhere;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .action:hover {
        transform: translateY(-1px);
      }

      .action-primary {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
      }

      .action-primary:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .action-secondary {
        color: var(--foreground);
        background: var(--surface);
      }

      .action-secondary:hover {
        border-color: var(--tone-info);
      }

      .history-card {
        text-align: left;
      }

      .history-card .section-heading {
        justify-items: start;
      }

      .history-list {
        margin-top: 12px;
        display: grid;
        gap: 10px;
      }

      .history-item {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px;
        background: var(--surface);
        display: grid;
        gap: 7px;
        min-width: 0;
      }

      .history-head,
      .history-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        color: var(--muted);
        font-size: 11px;
      }

      .history-head strong {
        color: var(--foreground);
        font-size: 12px;
      }

      .history-path {
        font-size: 12px;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .preview-grid {
        display: grid;
        gap: 8px;
      }

      .preview-grid span {
        color: var(--muted);
        display: block;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        margin-bottom: 4px;
      }

      .preview-grid pre {
        margin: 0;
        min-height: 32px;
        max-height: 72px;
        overflow: hidden;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-strong);
        color: var(--foreground);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        line-height: 1.35;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .mini-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .mini-action {
        appearance: none;
        border: 1px solid var(--button-border);
        border-radius: 8px;
        padding: 7px 9px;
        color: var(--foreground);
        background: var(--surface-strong);
        font: inherit;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }

      .mini-action:hover {
        border-color: var(--tone-info);
      }

      .history-empty {
        margin-top: 12px;
        color: var(--muted);
        font-size: 12px;
        text-align: center;
      }

      .footer {
        font-size: 11px;
        line-height: 1.4;
      }
`;

module.exports = {
  SIDEBAR_CSS
};
