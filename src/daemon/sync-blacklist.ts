"use strict";

import type { SyncBlacklistEntry } from "../shared/api-types";

const nodePath = require("node:path");

const BLACKLIST_MARKER_ATTRIBUTE = "AmarilloSync";
const BLACKLIST_MARKER_VALUE = "Blacklist";

export type { SyncBlacklistEntry } from "../shared/api-types";

function normalizePathSegments(value: unknown): string[] {
  const rawSegments = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(".") : []);
  return rawSegments
    .map((segment) => String(segment || "").trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => {
      const normalized = segment.toLowerCase();
      return normalized !== "game" && normalized !== "datamodel";
    });
}

function normalizeSyncBlacklist(value: unknown): SyncBlacklistEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byId = new Map<string, SyncBlacklistEntry>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const pathSegments = normalizePathSegments(candidate.path);
    if (!id || pathSegments.length === 0) {
      continue;
    }
    if (byId.has(id)) {
      continue;
    }
    const entry: SyncBlacklistEntry = {
      id,
      path: pathSegments.join(".")
    };
    if (typeof candidate.name === "string" && candidate.name.trim()) {
      entry.name = candidate.name.trim();
    }
    if (typeof candidate.className === "string" && candidate.className.trim()) {
      entry.className = candidate.className.trim();
    }
    byId.set(id, entry);
  }
  return Array.from(byId.values());
}

function pathSegments(value: unknown): string[] {
  return normalizePathSegments(value);
}

function isPathPrefix(prefix: string[], target: string[]): boolean {
  if (prefix.length === 0 || prefix.length > target.length) {
    return false;
  }
  return prefix.every((segment, index) => segment === target[index]);
}

function nodeAttributes(node: any): Record<string, unknown> {
  const attributes = node?.properties?.Attributes;
  return attributes && typeof attributes === "object" && !Array.isArray(attributes)
    ? attributes
    : {};
}

function hasBlacklistMarker(node: any): boolean {
  return node?.blacklisted === true
    || nodeAttributes(node)[BLACKLIST_MARKER_ATTRIBUTE] === BLACKLIST_MARKER_VALUE;
}

function entryMatchesNodeId(node: any, entries: SyncBlacklistEntry[]): boolean {
  const nodeId = typeof node?.amarilloId === "string" ? node.amarilloId : "";
  return nodeId.length > 0 && entries.some((entry) => entry.id === nodeId);
}

function entryMatchesPath(fullPath: string[], entries: SyncBlacklistEntry[]): boolean {
  return entries.some((entry) => isPathPrefix(pathSegments(entry.path), fullPath));
}

function isBlacklistedNode(node: any, fullPath: string[], entries: SyncBlacklistEntry[], mode: "local" | "studio" = "studio"): boolean {
  if (hasBlacklistMarker(node)) {
    return true;
  }
  if (entryMatchesNodeId(node, entries)) {
    return true;
  }
  return mode === "local" && entryMatchesPath(fullPath, entries);
}

function mountSegments(mount: any): string[] {
  if (Array.isArray(mount)) {
    return pathSegments(mount);
  }
  return pathSegments(mount?.segments || mount?.path || mount?.id);
}

function nodeName(node: any): string {
  return typeof node?.name === "string"
    ? node.name
    : (typeof node?.robloxName === "string" ? node.robloxName : "");
}

function filterSnapshotBySyncBlacklist(snapshot: any, blacklist: unknown, mode: "local" | "studio" = "studio") {
  const entries = normalizeSyncBlacklist(blacklist);
  if (entries.length === 0 || !snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const filterChildren = (children: unknown, parentPath: string[]) => {
    if (!Array.isArray(children)) {
      return [];
    }
    return children.flatMap((child) => {
      if (!child || typeof child !== "object") {
        return [];
      }
      const fullPath = parentPath.concat(nodeName(child));
      if (isBlacklistedNode(child, fullPath, entries, mode)) {
        return [];
      }
      return [{
        ...(child as Record<string, unknown>),
        children: filterChildren((child as any).children, fullPath)
      }];
    });
  };

  return {
    ...snapshot,
    mounts: Array.isArray(snapshot.mounts)
      ? snapshot.mounts.map((mount) => ({
          ...mount,
          children: filterChildren(mount?.children, mountSegments(mount))
        }))
      : []
  };
}

function isInstancePathBlacklisted(instancePath: unknown, blacklist: unknown): boolean {
  const target = pathSegments(instancePath);
  if (target.length === 0) {
    return false;
  }
  return entryMatchesPath(target, normalizeSyncBlacklist(blacklist));
}

function localRelativePathSegments(relativePath: string): string[] {
  const pieces = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (pieces.length === 0) {
    return [];
  }

  const lastIndex = pieces.length - 1;
  let last = pieces[lastIndex];
  if (/^init(?:\.server|\.client)?\.(?:lua|luau)$/i.test(last)
    || /^init\.meta\.json$/i.test(last)) {
    pieces.pop();
    return pieces;
  }
  if (/\.meta\.json$/i.test(last)) {
    last = last.replace(/\.meta\.json$/i, "");
  } else if (/(?:\.server|\.client)?\.(?:lua|luau)$/i.test(last)) {
    last = last.replace(/(?:\.server|\.client)?\.(?:lua|luau)$/i, "");
  } else if (/\.(?:model\.json|rbxm|rbxmx)$/i.test(last)) {
    last = last.replace(/\.(?:model\.json|rbxm|rbxmx)$/i, "");
  }
  pieces[lastIndex] = last;
  return pieces;
}

function isLocalFilePathBlacklisted(filePath: string, mountRoot: string, mountSegmentsValue: unknown, blacklist: unknown): boolean {
  if (!filePath || !mountRoot) {
    return false;
  }
  const relative = nodePath.relative(mountRoot, filePath);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    return false;
  }
  const target = mountSegments(mountSegmentsValue).concat(localRelativePathSegments(relative));
  return isInstancePathBlacklisted(target, blacklist);
}

function blacklistEntryForNode(node: any, fullPath: string[], blacklist: unknown): SyncBlacklistEntry | null {
  const entries = normalizeSyncBlacklist(blacklist);
  const nodeId = typeof node?.amarilloId === "string" ? node.amarilloId : "";
  return entries.find((entry) => entry.id === nodeId || isPathPrefix(pathSegments(entry.path), fullPath)) || null;
}

module.exports = {
  BLACKLIST_MARKER_ATTRIBUTE,
  BLACKLIST_MARKER_VALUE,
  blacklistEntryForNode,
  filterSnapshotBySyncBlacklist,
  isBlacklistedNode,
  isInstancePathBlacklisted,
  isLocalFilePathBlacklisted,
  normalizeSyncBlacklist,
  normalizePathSegments,
  pathSegments
};
