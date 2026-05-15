"use strict";

const { escapeHtml } = require("./sidebar-state");

// Sync history labels and renderers.

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

module.exports = {
  renderActivityEntry,
  renderSyncHistorySection,
  activityActionLabel,
  activityDirectionLabel,
  formatActivityTime,
  compactActivityPreview
};
