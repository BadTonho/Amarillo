"use strict";

function roundMs(value) {
  return Math.max(0, Math.round(Number(value || 0) * 1000) / 1000);
}

class PerfTracker {
  metrics: Map<string, any>;

  constructor() {
    this.metrics = new Map();
  }

  record(name, durationMs) {
    if (!name) {
      return null;
    }
    const value = roundMs(durationMs);
    const now = new Date().toISOString();
    const current = this.metrics.get(name) || {
      count: 0,
      lastMs: 0,
      avgMs: 0,
      maxMs: 0,
      totalMs: 0,
      lastAt: null
    };
    current.count += 1;
    current.lastMs = value;
    current.totalMs = roundMs(current.totalMs + value);
    current.avgMs = roundMs(current.totalMs / current.count);
    current.maxMs = Math.max(current.maxMs, value);
    current.lastAt = now;
    this.metrics.set(name, current);
    return current;
  }

  summary() {
    const result = {};
    for (const [name, metric] of this.metrics.entries()) {
      result[name] = { ...metric };
    }
    return result;
  }

  report() {
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      metrics: this.summary()
    };
  }
}

module.exports = {
  PerfTracker
};
