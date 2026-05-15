"use strict";

// Facade for the sidebar modules. Keep this public contract stable for extension.ts.

const state = require("./sidebar-state");
const render = require("./sidebar-render");
const activity = require("./sidebar-activity");
const styles = require("./sidebar-styles");

module.exports = {
  sidebarTone: state.sidebarTone,
  createSidebarFact: state.createSidebarFact,
  createSidebarAction: state.createSidebarAction,
  sidebarErrorMessage: state.sidebarErrorMessage,
  escapeHtml: state.escapeHtml,
  formatElapsedMs: state.formatElapsedMs,
  buildSidebarLoadingState: state.buildSidebarLoadingState,
  buildSidebarErrorState: state.buildSidebarErrorState,
  renderSidebarHtml: render.renderSidebarHtml,
  renderSidebarFatalHtml: render.renderSidebarFatalHtml,
  renderSidebarFact: render.renderSidebarFact,
  renderSidebarAction: render.renderSidebarAction,
  renderSidebarSection: render.renderSidebarSection,
  renderActivityEntry: activity.renderActivityEntry,
  renderSyncHistorySection: activity.renderSyncHistorySection,
  activityActionLabel: activity.activityActionLabel,
  activityDirectionLabel: activity.activityDirectionLabel,
  formatActivityTime: activity.formatActivityTime,
  compactActivityPreview: activity.compactActivityPreview,
  SIDEBAR_CSS: styles.SIDEBAR_CSS
};
