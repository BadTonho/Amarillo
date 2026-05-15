"use strict";

// ===== Sidebar module: rendering, state building, HTML generation =====
// Extracted from extension.ts to reduce monolithic file size.

const vscode = require("vscode");

// ----- Types (sidebar-specific) -----

interface SidebarFact {
  label: string;
  value: string;
  tone: string;
}

interface SidebarAction {
  label: string;
  command: string;
  variant: string;
  detail?: string;
}

interface SidebarSection {
  title: string;
  description?: string;
  actions: SidebarAction[];
}

interface SidebarHistory {
  entries?: any[];
  error?: string | null;
}

interface SidebarSessionState {
  title: string;
  tone: string;
  badge: string;
  message: string;
  facts: SidebarFact[];
  actions: SidebarAction[];
}

interface SidebarStatusState {
  title: string;
  tone: string;
  endpoint: string;
  workspace: string;
  notes: string[];
}

interface SidebarState {
  status: SidebarStatusState;
  session: SidebarSessionState;
  sections: SidebarSection[];
  history?: SidebarHistory;
}

// ----- Helper functions -----

function sidebarTone(value) {
  switch (value) {
    case "success":
    case "warning":
    case "danger":
    case "info":
      return value;
    default:
      return "neutral";
  }
}

function createSidebarFact(label, value, tone = "neutral"): SidebarFact {
  return {
    label,
    value,
    tone: sidebarTone(tone)
  };
}

function createSidebarAction(label, command, variant = "secondary", detail = ""): SidebarAction {
  return {
    label,
    command,
    variant: variant === "primary" ? "primary" : "secondary",
    detail
  };
}

function sidebarErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown sidebar error.");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatElapsedMs(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "0s";
  }
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

// ----- Sidebar state builders -----

function buildSidebarLoadingState(): SidebarState {
  return {
    status: {
      title: "Loading Amarillo",
      tone: "info",
      endpoint: "checking",
      workspace: "checking workspace",
      notes: ["Preparing Bridge, Studio Session, Sync, MCP, and Workspace status."]
    },
    session: {
      title: "Studio Session",
      tone: "info",
      badge: "Loading",
      message: "The sidebar is loading the current bridge state.",
      facts: [
        createSidebarFact("Bridge", "Checking", "info"),
        createSidebarFact("Studio Session", "Checking", "info"),
        createSidebarFact("Sync", "Checking", "info"),
        createSidebarFact("MCP", "Checking", "info"),
        createSidebarFact("Workspace", "Checking", "info")
      ],
      actions: [
        createSidebarAction("Refresh Sidebar", "amarillo.refreshSidebar", "primary"),
        createSidebarAction("Open Output", "amarillo.openOutput")
      ]
    },
    sections: []
  };
}

function buildSidebarErrorState(error): SidebarState {
  const message = sidebarErrorMessage(error);
  return {
    status: {
      title: "Sidebar needs attention",
      tone: "danger",
      endpoint: "load failed",
      workspace: "not available",
      notes: [
        "The Amarillo panel could not finish loading.",
        message
      ]
    },
    session: {
      title: "Studio Session",
      tone: "danger",
      badge: "Error",
      message: "Use the actions below to reload the panel or open diagnostics.",
      facts: [
        createSidebarFact("Bridge", "Unknown", "warning"),
        createSidebarFact("Studio Session", "Not loaded", "danger"),
        createSidebarFact("Sync", "Not loaded", "danger"),
        createSidebarFact("MCP", "Unknown", "warning"),
        createSidebarFact("Workspace", "Unknown", "neutral")
      ],
      actions: [
        createSidebarAction("Refresh Sidebar", "amarillo.refreshSidebar", "primary"),
        createSidebarAction("Open Output", "amarillo.openOutput"),
        createSidebarAction("Start Bridge", "amarillo.startBridge"),
        createSidebarAction("Doctor", "amarillo.doctor")
      ]
    },
    sections: []
  };
}

// ----- HTML renderers -----

function renderSidebarFact(fact) {
  return `
    <div class="fact tone-${escapeHtml(fact.tone)}">
      <span class="fact-label">${escapeHtml(fact.label)}</span>
      <span class="fact-value">${escapeHtml(fact.value)}</span>
    </div>
  `;
}

function renderSidebarAction(action) {
  const detail = action.detail ? ` title="${escapeHtml(action.detail)}"` : "";
  return `
    <button
      class="action action-${escapeHtml(action.variant)}"
      type="button"
      data-command="${escapeHtml(action.command)}"${detail}
    >
      ${escapeHtml(action.label)}
    </button>
  `;
}

function renderSidebarSection(section) {
  return `
    <section class="card">
      <div class="section-heading">
        <h3>${escapeHtml(section.title)}</h3>
        <p>${escapeHtml(section.description || "")}</p>
      </div>
      <div class="actions-grid">
        ${section.actions.map(renderSidebarAction).join("")}
      </div>
    </section>
  `;
}

function activityActionLabel(action) {
  switch (action) {
    case "create": return "Created";
    case "delete": return "Deleted";
    case "modify": return "Modified";
    default: return action || "Changed";
  }
}

function activityDirectionLabel(direction) {
  switch (direction) {
    case "pc_to_studio": return "VS Code -> Studio";
    case "studio_to_pc": return "Studio -> VS Code";
    default: return direction || "local";
  }
}

function formatActivityTime(timestamp) {
  const parsed = timestamp ? new Date(timestamp) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    return "unknown time";
  }
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function compactActivityPreview(value) {
  if (typeof value !== "string") {
    return "snapshot unavailable";
  }
  const compact = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(empty)";
  }
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function renderActivityEntry(entry) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const detail = entry?.detail || {};
  const canDiff = typeof detail.oldText === "string" || typeof detail.newText === "string";
  const canRevert = entry?.canRevert === true;
  const pathLabel = entry?.relativePath || entry?.path || "unknown file";
  const snapshotLabel = entry?.hasTextSnapshot
    ? "text snapshot"
    : (entry?.oldHash || entry?.newHash ? "metadata only" : "no snapshot");
  const oldPreview = compactActivityPreview(detail.oldText);
  const newPreview = compactActivityPreview(detail.newText);
  const buttons = [];
  if (canDiff && id) {
    buttons.push(`<button class="mini-action" type="button" data-activity-action="openDiff" data-activity-id="${escapeHtml(id)}">Open Diff</button>`);
  }
  if (canRevert && id) {
    buttons.push(`<button class="mini-action" type="button" data-activity-action="revert" data-activity-id="${escapeHtml(id)}">Revert</button>`);
  }

  return `
    <article class="history-item">
      <div class="history-head">
        <strong>${escapeHtml(activityActionLabel(entry?.action))}</strong>
        <span>${escapeHtml(formatActivityTime(entry?.timestamp))}</span>
      </div>
      <div class="history-path">${escapeHtml(pathLabel)}</div>
      <div class="history-meta">
        <span>${escapeHtml(activityDirectionLabel(entry?.direction))}</span>
        <span>${escapeHtml(snapshotLabel)}</span>
      </div>
      <div class="preview-grid">
        <div>
          <span>Before</span>
          <pre>${escapeHtml(oldPreview)}</pre>
        </div>
        <div>
          <span>After</span>
          <pre>${escapeHtml(newPreview)}</pre>
        </div>
      </div>
      ${buttons.length > 0 ? `<div class="mini-actions">${buttons.join("")}</div>` : ""}
    </article>
  `;
}

function renderSyncHistorySection(history) {
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const body = entries.length > 0
    ? `<div class="history-list">${entries.map(renderActivityEntry).join("")}</div>`
    : `<p class="history-empty">${escapeHtml(history?.error || "No recent file changes recorded yet.")}</p>`;
  return `
    <section class="card history-card">
      <div class="section-heading">
        <h3>Sync History</h3>
        <p>Last 10 changes.</p>
      </div>
      ${body}
    </section>
  `;
}

// ----- CSS -----

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

// ----- Main HTML renderer -----

function renderSidebarHtml(state: SidebarState) {
  const status = state?.status || {} as SidebarStatusState;
  const session = state?.session || {} as SidebarSessionState;
  const statusNotes = Array.isArray(status.notes) ? status.notes : [];
  const sessionFacts = Array.isArray(session.facts) ? session.facts : [];
  const sessionActions = Array.isArray(session.actions) ? session.actions : [];
  const sections = Array.isArray(state?.sections) ? state.sections : [];
  const history = state?.history || {};
  const statusTone = sidebarTone(status.tone);
  const sessionTone = sidebarTone(session.tone);
  const notesMarkup = statusNotes.length > 0
    ? `
      <div class="notes">
        ${statusNotes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
      </div>
    `
    : "";
  const factsMarkup = sessionFacts.length > 0
    ? `
      <div class="facts-grid">
        ${sessionFacts.map(renderSidebarFact).join("")}
      </div>
    `
    : "";
  const sessionActionsMarkup = sessionActions.length > 0
    ? `
      <div class="actions-grid compact">
        ${sessionActions.map(renderSidebarAction).join("")}
      </div>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
${SIDEBAR_CSS}
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card hero tone-border-${escapeHtml(statusTone)}">
        <div class="eyebrow">Amarillo Bridge</div>
        <h1>${escapeHtml(status.title || "Bridge status")}</h1>
        <span class="badge tone-${escapeHtml(statusTone)}">${escapeHtml(status.endpoint || "unknown")}</span>
        <div class="hero-meta">
          <div class="meta-row">
            <span>Workspace</span>
            <strong>${escapeHtml(status.workspace || "no workspace")}</strong>
          </div>
        </div>
        ${notesMarkup}
      </section>

      <section class="card tone-border-${escapeHtml(sessionTone)}">
        <div class="session-copy">
          <div class="section-heading">
            <h2>${escapeHtml(session.title || "Studio Session")}</h2>
            <span class="badge tone-${escapeHtml(sessionTone)}">${escapeHtml(session.badge || "Unknown")}</span>
          </div>
          <p class="message">${escapeHtml(session.message || "No sidebar details are available yet.")}</p>
          ${factsMarkup}
          ${sessionActionsMarkup}
        </div>
      </section>

      ${sections.map(renderSidebarSection).join("")}

      ${renderSyncHistorySection(history)}

      <p class="footer">Atalho rapido: Ctrl+Shift+A abre o menu completo do Amarillo.</p>
    </main>

    <script>
      const vscode = acquireVsCodeApi();
      document.addEventListener("click", (event) => {
        const activityButton = event.target.closest("[data-activity-action]");
        if (activityButton) {
          vscode.postMessage({
            type: "activity",
            action: activityButton.dataset.activityAction,
            id: activityButton.dataset.activityId
          });
          return;
        }
        const button = event.target.closest("[data-command]");
        if (!button) {
          return;
        }
        vscode.postMessage({
          type: "command",
          command: button.dataset.command
        });
      });
    </script>
  </body>
</html>`;
}

function renderSidebarFatalHtml(error) {
  const message = escapeHtml(sidebarErrorMessage(error));
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        margin: 0;
        padding: 14px;
        color: var(--vscode-foreground, #cccccc);
        background: var(--vscode-sideBar-background, #1f1f1f);
        font-family: var(--vscode-font-family);
        text-align: center;
      }

      .panel {
        border: 1px solid var(--vscode-charts-red, #f85149);
        border-radius: 8px;
        padding: 14px;
        background: var(--vscode-editorWidget-background, #252526);
      }

      h1 {
        margin: 0 0 8px;
        font-size: 14px;
        letter-spacing: 0;
      }

      p {
        margin: 0;
        color: var(--vscode-descriptionForeground, #9da5b4);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <section class="panel">
      <h1>Amarillo sidebar failed to render</h1>
      <p>${message}</p>
    </section>
  </body>
</html>`;
}

// ----- Exports -----

module.exports = {
  sidebarTone,
  createSidebarFact,
  createSidebarAction,
  sidebarErrorMessage,
  escapeHtml,
  formatElapsedMs,
  buildSidebarLoadingState,
  buildSidebarErrorState,
  renderSidebarHtml,
  renderSidebarFatalHtml,
  renderSidebarFact,
  renderSidebarAction,
  renderSidebarSection,
  renderActivityEntry,
  renderSyncHistorySection,
  activityActionLabel,
  activityDirectionLabel,
  formatActivityTime,
  compactActivityPreview,
  SIDEBAR_CSS
};
