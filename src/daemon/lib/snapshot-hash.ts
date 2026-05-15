"use strict";

const crypto = require("node:crypto");

function normalizeSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    ...value,
    mounts: (value.mounts || []).map((mount) => ({
      ...mount,
      children: mount.children || []
    }))
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

module.exports = {
  hashSnapshot,
  normalizeAndHashSnapshot,
  normalizeSnapshot,
  stringifySorted
};
