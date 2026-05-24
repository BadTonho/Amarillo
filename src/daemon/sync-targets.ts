"use strict";

export interface SyncTargets {
  Workspace: boolean;
  [key: string]: boolean;
}

const DEFAULT_SYNC_TARGETS: SyncTargets = {
  Workspace: false
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeSyncTargets(value: unknown = null): SyncTargets {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const workspaceValue = hasOwn(input, "Workspace")
    ? input.Workspace
    : (hasOwn(input, "workspace") ? input.workspace : DEFAULT_SYNC_TARGETS.Workspace);
  return {
    Workspace: normalizeBoolean(workspaceValue, DEFAULT_SYNC_TARGETS.Workspace)
  };
}

function mountSegments(mountOrSegments): string[] {
  if (Array.isArray(mountOrSegments)) {
    return mountOrSegments.filter((segment) => typeof segment === "string");
  }
  if (Array.isArray(mountOrSegments?.segments)) {
    return mountOrSegments.segments.filter((segment) => typeof segment === "string");
  }
  if (typeof mountOrSegments?.path === "string") {
    return mountOrSegments.path.split(".").filter(Boolean);
  }
  if (typeof mountOrSegments?.id === "string") {
    return mountOrSegments.id.split(".").filter(Boolean);
  }
  return [];
}

function isWorkspaceMount(mountOrSegments): boolean {
  return mountSegments(mountOrSegments)[0] === "Workspace";
}

function isMountSyncEnabled(mountOrSegments, syncTargets: SyncTargets = DEFAULT_SYNC_TARGETS): boolean {
  const targets = normalizeSyncTargets(syncTargets);
  if (isWorkspaceMount(mountOrSegments)) {
    return targets.Workspace === true;
  }
  return true;
}

function filterSnapshotBySyncTargets(snapshot, syncTargets: SyncTargets = DEFAULT_SYNC_TARGETS) {
  const targets = normalizeSyncTargets(syncTargets);
  const mounts = Array.isArray(snapshot?.mounts) ? snapshot.mounts : [];
  return {
    ...(snapshot && typeof snapshot === "object" ? snapshot : {}),
    mounts: mounts.filter((mount) => isMountSyncEnabled(mount, targets))
  };
}

function filterProjectBySyncTargets(project, syncTargets: SyncTargets = DEFAULT_SYNC_TARGETS) {
  if (!project || typeof project !== "object") {
    return project;
  }
  const targets = normalizeSyncTargets(syncTargets);
  const mounts = Array.isArray(project.mounts) ? project.mounts : [];
  return {
    ...project,
    mounts: mounts.filter((mount) => isMountSyncEnabled(mount, targets))
  };
}

module.exports = {
  DEFAULT_SYNC_TARGETS,
  filterProjectBySyncTargets,
  filterSnapshotBySyncTargets,
  isMountSyncEnabled,
  isWorkspaceMount,
  normalizeSyncTargets
};
