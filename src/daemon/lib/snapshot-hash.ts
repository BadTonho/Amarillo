"use strict";

const crypto = require("node:crypto");

const VALID_FILE_KINDS = new Set(["server", "client", "module"]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeScriptSourceForSync(source) {
  return String(source ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/g, "");
}

function inferredFileKindForClass(className) {
  if (className === "Script") {
    return "server";
  }
  if (className === "LocalScript") {
    return "client";
  }
  if (className === "ModuleScript") {
    return "module";
  }
  return null;
}

function normalizeFileKind(node) {
  const explicit = typeof node?.fileKind === "string" ? node.fileKind : null;
  if (explicit && VALID_FILE_KINDS.has(explicit)) {
    return explicit;
  }
  return inferredFileKindForClass(node?.className);
}

function classNameForFileKind(fileKind) {
  if (fileKind === "server") {
    return "Script";
  }
  if (fileKind === "client") {
    return "LocalScript";
  }
  if (fileKind === "module") {
    return "ModuleScript";
  }
  return "Folder";
}

function normalizeClassName(node, fileKind) {
  if (typeof node?.className === "string" && node.className.length > 0) {
    return node.className;
  }
  return classNameForFileKind(fileKind);
}

function normalizeSemanticValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSemanticValue(item));
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((next, key) => {
        const item = value[key];
        if (item !== undefined) {
          next[key] = normalizeSemanticValue(item);
        }
        return next;
      }, {});
  }
  return value;
}

function normalizeProperties(properties) {
  return isPlainObject(properties) ? normalizeSemanticValue(properties) : {};
}

function isScriptLikeNode(node) {
  return Boolean(normalizeFileKind(node))
    || node?.className === "Script"
    || node?.className === "LocalScript"
    || node?.className === "ModuleScript";
}

function isOpaqueModelNode(node, fileKind = null) {
  return normalizeClassName(node, fileKind ?? normalizeFileKind(node)) === "Model";
}

function canonicalNodeSortKey(node) {
  return [
    node.name || "",
    node.className || "",
    node.fileKind || "",
    node.source || ""
  ].join("\u0000");
}

function normalizeNode(node, context: any = {}) {
  const value = isPlainObject(node) ? node : {};
  const fileKind = normalizeFileKind(value);
  const className = normalizeClassName(value, fileKind);
  if (isOpaqueModelNode(value, fileKind)) {
    return null;
  }
  const insideModel = context.insideModel === true;
  const isModel = className === "Model";
  const children = normalizeChildren(value.children, { insideModel: insideModel || isModel });
  if (insideModel && !fileKind && !isScriptLikeNode(value) && children.length === 0) {
    return null;
  }
  const normalized = {
    name: typeof value.name === "string" ? value.name : "",
    className,
    properties: insideModel && !fileKind && !isScriptLikeNode(value) ? {} : normalizeProperties(value.properties),
    children
  } as any;

  if (fileKind) {
    normalized.fileKind = fileKind;
  }
  if (fileKind || value.source !== undefined) {
    normalized.source = normalizeScriptSourceForSync(value.source);
  }
  return normalized;
}

function normalizeChildren(children, context: any = {}) {
  return (Array.isArray(children) ? children : [])
    .map((child) => normalizeNode(child, context))
    .filter(Boolean)
    .sort((left, right) => canonicalNodeSortKey(left).localeCompare(canonicalNodeSortKey(right)));
}

function normalizeSegments(mount) {
  if (Array.isArray(mount?.segments)) {
    return mount.segments.filter((segment) => typeof segment === "string");
  }
  if (typeof mount?.id === "string" && mount.id.length > 0) {
    return mount.id.split(".");
  }
  return [];
}

function normalizeSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    projectId: typeof value.projectId === "string" ? value.projectId : null,
    mounts: (Array.isArray(value.mounts) ? value.mounts : [])
      .map((mount) => ({
        id: typeof mount?.id === "string" ? mount.id : "",
        segments: normalizeSegments(mount),
        children: normalizeChildren(mount?.children)
      }))
      .sort((left, right) => [
        left.id,
        left.segments.join(".")
      ].join("\u0000").localeCompare([
        right.id,
        right.segments.join(".")
      ].join("\u0000")))
  };
}

function stringifySorted(value) {
  return JSON.stringify(value, (_key, item) => {
    if (Array.isArray(item)) {
      return item;
    }
    if (item && typeof item === "object") {
      return Object.keys(item)
        .sort()
        .reduce((next, key) => {
          next[key] = item[key];
          return next;
        }, {});
    }
    return item;
  });
}

function normalizeAndHashSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const json = stringifySorted(normalized);
  return {
    normalized,
    hash: crypto.createHash("sha1").update(json).digest("hex"),
    byteLength: Buffer.byteLength(json, "utf8")
  };
}

function hashSnapshot(snapshot) {
  return normalizeAndHashSnapshot(snapshot).hash;
}

function rawChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function rawMounts(snapshot) {
  return Array.isArray(snapshot?.mounts) ? snapshot.mounts : [];
}

function indexByName(items, context: any = {}) {
  const indexed = new Map();
  for (const item of items || []) {
    if (!normalizeNode(item, context)) {
      continue;
    }
    const name = typeof item?.name === "string" ? item.name : "";
    if (!indexed.has(name)) {
      indexed.set(name, []);
    }
    indexed.get(name).push(item);
  }
  for (const bucket of indexed.values()) {
    bucket.sort((left, right) => canonicalNodeSortKey(normalizeNode(left, context) || {}).localeCompare(canonicalNodeSortKey(normalizeNode(right, context) || {})));
  }
  return indexed;
}

function compactValue(value) {
  const json = stringifySorted(value);
  return json.length > 140 ? `${json.slice(0, 137)}...` : json;
}

function isAllowedCorrectedStudioClass(expectedNode, observedNode, options) {
  if (options?.allowCorrectedStudioClasses !== true) {
    return false;
  }
  return expectedNode?.className === "Folder"
    && expectedNode?.classNameSource === "defaultFolder"
    && observedNode?.classNameSource === "studio"
    && !normalizeFileKind(expectedNode)
    && !normalizeFileKind(observedNode);
}

function diffSnapshots(expectedSnapshot, observedSnapshot, options: any = {}) {
  const maxChanges = Number.isFinite(options.maxChanges) ? Math.max(1, options.maxChanges) : 20;
  const changes = [];
  let changeCount = 0;

  function addChange(change) {
    changeCount++;
    if (changes.length < maxChanges) {
      changes.push(change);
    }
  }

  function compareNodes(pathLabel, expectedNode, observedNode, context: any = {}) {
    if (!expectedNode && observedNode) {
      addChange({ path: pathLabel, type: "unexpected_in_studio", observedClassName: observedNode.className || null });
      return;
    }
    if (expectedNode && !observedNode) {
      addChange({ path: pathLabel, type: "missing_in_studio", expectedClassName: expectedNode.className || null });
      return;
    }

    const expectedNormalized = normalizeNode(expectedNode, context);
    const observedNormalized = normalizeNode(observedNode, context);
    if (!expectedNormalized && !observedNormalized) {
      return;
    }
    if (!expectedNormalized && observedNormalized) {
      addChange({ path: pathLabel, type: "unexpected_in_studio", observedClassName: observedNormalized.className || null });
      return;
    }
    if (expectedNormalized && !observedNormalized) {
      addChange({ path: pathLabel, type: "missing_in_studio", expectedClassName: expectedNormalized.className || null });
      return;
    }
    const classCorrectionAllowed = isAllowedCorrectedStudioClass(expectedNode, observedNode, options);

    if (!classCorrectionAllowed && expectedNormalized.className !== observedNormalized.className) {
      addChange({
        path: pathLabel,
        type: "className",
        expected: expectedNormalized.className,
        observed: observedNormalized.className
      });
    }
    if ((expectedNormalized.fileKind || null) !== (observedNormalized.fileKind || null)) {
      addChange({
        path: pathLabel,
        type: "fileKind",
        expected: expectedNormalized.fileKind || null,
        observed: observedNormalized.fileKind || null
      });
    }
    if ((expectedNormalized.source || "") !== (observedNormalized.source || "")) {
      addChange({ path: pathLabel, type: "source" });
    }

    const expectedProperties = stringifySorted(expectedNormalized.properties || {});
    const observedProperties = stringifySorted(observedNormalized.properties || {});
    if (expectedProperties !== observedProperties) {
      addChange({
        path: pathLabel,
        type: "properties",
        expected: compactValue(expectedNormalized.properties || {}),
        observed: compactValue(observedNormalized.properties || {})
      });
    }

    const childContext = {
      insideModel: context.insideModel === true || expectedNormalized.className === "Model" || observedNormalized.className === "Model"
    };
    compareChildren(pathLabel, rawChildren(expectedNode), rawChildren(observedNode), childContext);
  }

  function compareChildren(parentPath, expectedChildren, observedChildren, context: any = {}) {
    const expectedByName = indexByName(expectedChildren, context);
    const observedByName = indexByName(observedChildren, context);
    const names = new Set([...expectedByName.keys(), ...observedByName.keys()]);
    for (const name of Array.from(names).sort()) {
      const expectedItems = expectedByName.get(name) || [];
      const observedItems = observedByName.get(name) || [];
      const maxLength = Math.max(expectedItems.length, observedItems.length);
      if (expectedItems.length !== observedItems.length && (expectedItems.length > 1 || observedItems.length > 1)) {
        addChange({
          path: parentPath ? `${parentPath}/${name}` : name,
          type: "duplicate_name",
          expectedCount: expectedItems.length,
          observedCount: observedItems.length
        });
      }
      for (let index = 0; index < maxLength; index++) {
        const suffix = maxLength > 1 ? `#${index + 1}` : "";
        compareNodes(parentPath ? `${parentPath}/${name}${suffix}` : `${name}${suffix}`, expectedItems[index], observedItems[index], context);
      }
    }
  }

  const expectedProjectId = typeof expectedSnapshot?.projectId === "string" ? expectedSnapshot.projectId : null;
  const observedProjectId = typeof observedSnapshot?.projectId === "string" ? observedSnapshot.projectId : null;
  if (expectedProjectId !== observedProjectId) {
    addChange({ path: "$", type: "projectId", expected: expectedProjectId, observed: observedProjectId });
  }

  const expectedMounts = new Map(rawMounts(expectedSnapshot).map((mount) => [mount.id, mount]));
  const observedMounts = new Map(rawMounts(observedSnapshot).map((mount) => [mount.id, mount]));
  const mountIds = new Set([...expectedMounts.keys(), ...observedMounts.keys()]);
  for (const mountId of Array.from(mountIds).sort()) {
    const expectedMount = expectedMounts.get(mountId);
    const observedMount = observedMounts.get(mountId);
    if (!expectedMount && observedMount) {
      addChange({ path: `[${mountId}]`, type: "unexpected_mount" });
      continue;
    }
    if (expectedMount && !observedMount) {
      addChange({ path: `[${mountId}]`, type: "missing_mount" });
      continue;
    }

    const expectedSegments = normalizeSegments(expectedMount).join(".");
    const observedSegments = normalizeSegments(observedMount).join(".");
    if (expectedSegments !== observedSegments) {
      addChange({
        path: `[${mountId}]`,
        type: "segments",
        expected: expectedSegments,
        observed: observedSegments
      });
    }
    compareChildren(String(mountId), rawChildren(expectedMount), rawChildren(observedMount));
  }

  return {
    changes,
    changeCount,
    truncated: changeCount > changes.length
  };
}

function snapshotsMatch(expectedSnapshot, observedSnapshot, options: any = {}) {
  return diffSnapshots(expectedSnapshot, observedSnapshot, { ...options, maxChanges: 1 }).changeCount === 0;
}

module.exports = {
  diffSnapshots,
  hashSnapshot,
  normalizeAndHashSnapshot,
  normalizeSnapshot,
  normalizeScriptSourceForSync,
  snapshotsMatch,
  stringifySorted
};
