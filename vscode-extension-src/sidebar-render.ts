"use strict";

const {
  sidebarTone,
  sidebarErrorMessage,
  escapeHtml
} = require("./sidebar-state");
const { renderSyncHistorySection } = require("./sidebar-activity");
const { SIDEBAR_CSS } = require("./sidebar-styles");

// HTML renderers.

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

// ----- Main HTML renderer -----

function renderSidebarHtml(state) {
  const status = state?.status || {};
  const session = state?.session || {};
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

module.exports = {
  renderSidebarHtml,
  renderSidebarFatalHtml,
  renderSidebarFact,
  renderSidebarAction,
  renderSidebarSection
};
