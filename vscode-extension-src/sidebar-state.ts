"use strict";

// Shared sidebar state helpers and fallback states.

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

module.exports = {
  sidebarTone,
  createSidebarFact,
  createSidebarAction,
  sidebarErrorMessage,
  escapeHtml,
  formatElapsedMs,
  buildSidebarLoadingState,
  buildSidebarErrorState
};
