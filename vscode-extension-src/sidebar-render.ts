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

function checkedAttribute(value) {
  return value ? " checked" : "";
}

function hiddenAttribute(value) {
  return value ? " hidden" : "";
}

function renderPlaceSyncMountCheckbox(mount, kind, selectedIds = []) {
  return `
    <label class="place-sync-check">
      <input
        type="checkbox"
        data-place-sync-mount="${escapeHtml(mount.id)}"
        data-place-sync-kind="${escapeHtml(kind)}"
        value="${escapeHtml(mount.id)}"${checkedAttribute(selectedIds.includes(mount.id))}
      />
      <span>
        <strong>${escapeHtml(mount.label || mount.id)}</strong>
        <small>${escapeHtml(kind === "base" ? (mount.baseRelativePath || mount.path || mount.id) : (mount.exclusiveRelativePath || mount.path || mount.id))}</small>
      </span>
    </label>
  `;
}

function renderPlaceSyncMountList(placeSync, context, kind) {
  const selectedIds = Array.isArray(context?.[`${kind}MountIds`]) ? context[`${kind}MountIds`] : [];
  const mounts = Array.isArray(placeSync?.mountOptions) ? placeSync.mountOptions : [];
  const stateMounts = Array.isArray(context?.mounts) ? context.mounts : [];
  return mounts.map((mount) => {
    const stateMount = stateMounts.find((candidate) => candidate.id === mount.id) || {};
    return renderPlaceSyncMountCheckbox({ ...mount, ...stateMount }, kind, selectedIds);
  }).join("");
}

function renderPlaceSyncProjectOptions(placeSync) {
  const projects = Array.isArray(placeSync?.projects) ? placeSync.projects : [];
  return projects.map((project) => `
    <option value="${escapeHtml(project.id)}"${project.id === placeSync.selectedProjectId ? " selected" : ""}>
      ${escapeHtml(project.label || project.name || project.id)}
    </option>
  `).join("");
}

function renderPlaceSyncPanel(placeSync) {
  if (!placeSync) {
    return "";
  }
  if (!placeSync.enabled) {
    return `
      <section class="card place-sync-card">
        <div class="section-heading">
          <h3>${escapeHtml(placeSync.title || "Place Sync")}</h3>
          <p>${escapeHtml(placeSync.description || "Place sync is not available right now.")}</p>
        </div>
      </section>
    `;
  }

  const mode = placeSync.mode === "create" ? "create" : "edit";
  const projects = Array.isArray(placeSync.projects) ? placeSync.projects : [];
  const currentContext = mode === "create"
    ? (placeSync.create || {})
    : (projects.find((project) => project.id === placeSync.selectedProjectId) || projects[0] || {});
  const baseUseDefault = currentContext.baseUseDefault !== false;
  const exclusiveUseDefault = currentContext.exclusiveUseDefault !== false;
  const stateJson = JSON.stringify(placeSync);

  return `
    <section class="card place-sync-card" data-place-sync-state="${escapeHtml(stateJson)}">
      <div class="section-heading">
        <h3>${escapeHtml(placeSync.title || "Place Sync")}</h3>
        <p>${escapeHtml(placeSync.description || "")}</p>
      </div>
      <form class="place-sync-form" data-place-sync-form data-place-sync-mode="${escapeHtml(mode)}">
        <div class="place-sync-status" data-place-sync-status hidden></div>

        ${mode === "create" ? `
          <div class="place-sync-fields">
            <label>
              <span>Place name</span>
              <input type="text" data-place-sync-place-name value="${escapeHtml(currentContext.placeName || "")}" />
            </label>
            <label>
              <span>Place ID</span>
              <input type="number" min="1" step="1" data-place-sync-place-id value="${escapeHtml(currentContext.placeId || "")}" />
            </label>
          </div>
          <p class="place-sync-note">Source: ${escapeHtml(currentContext.sourceProjectLabel || "default layout")}</p>
        ` : `
          <label class="place-sync-select-row">
            <span>Project</span>
            <select data-place-sync-project>
              ${renderPlaceSyncProjectOptions(placeSync)}
            </select>
          </label>
        `}

        <div class="place-sync-group">
          <label class="place-sync-toggle">
            <input type="checkbox" data-place-sync-master="base"${checkedAttribute(baseUseDefault)} />
            <span>Sync shared sync/src folders</span>
          </label>
          <div class="place-sync-list" data-place-sync-list="base"${hiddenAttribute(baseUseDefault)}>
            ${renderPlaceSyncMountList(placeSync, currentContext, "base")}
          </div>
        </div>

        <div class="place-sync-group">
          <label class="place-sync-toggle">
            <input type="checkbox" data-place-sync-master="exclusive"${checkedAttribute(exclusiveUseDefault)} />
            <span>Sync exclusive place folders</span>
          </label>
          <div class="place-sync-list" data-place-sync-list="exclusive"${hiddenAttribute(exclusiveUseDefault)}>
            ${renderPlaceSyncMountList(placeSync, currentContext, "exclusive")}
          </div>
        </div>

        <label class="place-sync-toggle">
          <input type="checkbox" data-place-sync-keep-unknowns${checkedAttribute(currentContext.keepUnknowns !== false)} />
          <span>Keep unmapped Studio instances</span>
        </label>

        <button class="action action-primary place-sync-apply" type="submit">Apply Place Sync</button>
      </form>
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
  const placeSyncMarkup = renderPlaceSyncPanel(state?.placeSync || null);
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

      ${placeSyncMarkup}

      ${sections.map(renderSidebarSection).join("")}

      ${renderSyncHistorySection(history)}

      <p class="footer">Atalho rapido: Ctrl+Shift+A abre o menu completo do Amarillo.</p>
    </main>

    <script>
      const vscode = acquireVsCodeApi();
      const escapeText = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      function readPlaceSyncState(form) {
        const panel = form.closest("[data-place-sync-state]");
        if (!panel) {
          return null;
        }
        try {
          return JSON.parse(panel.dataset.placeSyncState || "{}");
        } catch (_error) {
          return null;
        }
      }

      function placeSyncContext(form, state) {
        if (!state) {
          return null;
        }
        if (form.dataset.placeSyncMode === "create") {
          return state.create || null;
        }
        const projectId = form.querySelector("[data-place-sync-project]")?.value || state.selectedProjectId;
        const projects = Array.isArray(state.projects) ? state.projects : [];
        return projects.find((project) => project.id === projectId) || projects[0] || null;
      }

      function placeSyncDefaultIds(context, kind) {
        const key = kind === "base" ? "defaultBaseMountIds" : "defaultExclusiveMountIds";
        return Array.isArray(context?.[key]) ? context[key] : [];
      }

      function placeSyncSelectedIds(context, kind) {
        const key = kind === "base" ? "baseMountIds" : "exclusiveMountIds";
        return Array.isArray(context?.[key]) ? context[key] : [];
      }

      function renderPlaceSyncList(form, state, kind) {
        const list = form.querySelector("[data-place-sync-list='" + kind + "']");
        const context = placeSyncContext(form, state);
        if (!list || !context) {
          return;
        }
        const selected = new Set(placeSyncSelectedIds(context, kind));
        const stateMounts = Array.isArray(context.mounts) ? context.mounts : [];
        const mounts = Array.isArray(state.mountOptions) ? state.mountOptions : [];
        list.innerHTML = mounts.map((mount) => {
          const stateMount = stateMounts.find((candidate) => candidate.id === mount.id) || {};
          const merged = { ...mount, ...stateMount };
          const detail = kind === "base"
            ? (merged.baseRelativePath || merged.path || merged.id)
            : (merged.exclusiveRelativePath || merged.path || merged.id);
          const checked = selected.has(merged.id) ? " checked" : "";
          return '<label class="place-sync-check">'
            + '<input type="checkbox" data-place-sync-mount="' + escapeText(merged.id) + '" data-place-sync-kind="' + escapeText(kind) + '" value="' + escapeText(merged.id) + '"' + checked + ' />'
            + '<span><strong>' + escapeText(merged.label || merged.id) + '</strong><small>' + escapeText(detail) + '</small></span>'
            + '</label>';
        }).join("");
      }

      function syncPlaceSyncGroup(form, kind) {
        const master = form.querySelector("[data-place-sync-master='" + kind + "']");
        const list = form.querySelector("[data-place-sync-list='" + kind + "']");
        if (master && list) {
          list.hidden = master.checked;
        }
      }

      function refreshPlaceSyncForm(form) {
        const state = readPlaceSyncState(form);
        const context = placeSyncContext(form, state);
        if (!state || !context) {
          return;
        }
        renderPlaceSyncList(form, state, "base");
        renderPlaceSyncList(form, state, "exclusive");
        const baseMaster = form.querySelector("[data-place-sync-master='base']");
        const exclusiveMaster = form.querySelector("[data-place-sync-master='exclusive']");
        const keepUnknowns = form.querySelector("[data-place-sync-keep-unknowns]");
        if (baseMaster) baseMaster.checked = context.baseUseDefault !== false;
        if (exclusiveMaster) exclusiveMaster.checked = context.exclusiveUseDefault !== false;
        if (keepUnknowns) keepUnknowns.checked = context.keepUnknowns !== false;
        syncPlaceSyncGroup(form, "base");
        syncPlaceSyncGroup(form, "exclusive");
      }

      function checkedPlaceSyncMountIds(form, kind) {
        return Array.from(form.querySelectorAll("[data-place-sync-kind='" + kind + "']:checked"))
          .map((input) => input.value)
          .filter(Boolean);
      }

      function placeSyncPayloadIds(form, context, kind) {
        const master = form.querySelector("[data-place-sync-master='" + kind + "']");
        return master?.checked ? placeSyncDefaultIds(context, kind) : checkedPlaceSyncMountIds(form, kind);
      }

      function setPlaceSyncStatus(form, message) {
        const status = form.querySelector("[data-place-sync-status]");
        if (!status) {
          return;
        }
        status.textContent = message || "";
        status.hidden = !message;
      }

      document.querySelectorAll("[data-place-sync-form]").forEach((form) => refreshPlaceSyncForm(form));

      document.addEventListener("change", (event) => {
        const form = event.target.closest("[data-place-sync-form]");
        if (!form) {
          return;
        }
        if (event.target.matches("[data-place-sync-project]")) {
          refreshPlaceSyncForm(form);
          return;
        }
        if (event.target.matches("[data-place-sync-master]")) {
          syncPlaceSyncGroup(form, event.target.dataset.placeSyncMaster);
        }
      });

      document.addEventListener("submit", (event) => {
        const form = event.target.closest("[data-place-sync-form]");
        if (!form) {
          return;
        }
        event.preventDefault();
        const state = readPlaceSyncState(form);
        const context = placeSyncContext(form, state);
        if (!state || !context) {
          setPlaceSyncStatus(form, "Place sync state is not available.");
          return;
        }
        const baseMountIds = placeSyncPayloadIds(form, context, "base");
        const exclusiveMountIds = placeSyncPayloadIds(form, context, "exclusive");
        setPlaceSyncStatus(form, "");
        vscode.postMessage({
          type: "placeSyncApply",
          mode: form.dataset.placeSyncMode,
          projectId: form.querySelector("[data-place-sync-project]")?.value || "",
          placeName: form.querySelector("[data-place-sync-place-name]")?.value || "",
          placeId: form.querySelector("[data-place-sync-place-id]")?.value || "",
          baseMountIds,
          exclusiveMountIds,
          keepUnknowns: form.querySelector("[data-place-sync-keep-unknowns]")?.checked === true
        });
      });

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
