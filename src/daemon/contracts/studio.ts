"use strict";

export interface RuntimeSnapshotNode {
  name?: string;
  className?: string;
  fileKind?: string | null;
  source?: string;
  segments?: string[];
  children?: RuntimeSnapshotNode[];
  [key: string]: unknown;
}

export interface StudioSnapshot {
  mounts?: RuntimeSnapshotNode[];
  [key: string]: unknown;
}
