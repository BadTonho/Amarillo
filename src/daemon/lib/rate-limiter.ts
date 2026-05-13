"use strict";

/**
 * Simple sliding-window rate limiter for the Amarillo daemon HTTP server.
 *
 * Limits requests per remote address within a configurable time window.
 * Designed to prevent runaway loops or abusive clients without impacting
 * normal sync + MCP AI usage patterns.
 */

interface RateLimiterOptions {
  /** Maximum requests allowed per window (default: 120). */
  maxRequests?: number;
  /** Window duration in milliseconds (default: 1000). */
  windowMs?: number;
  /** Interval in milliseconds for cleaning up stale entries (default: 30000). */
  cleanupIntervalMs?: number;
}

interface RateLimiterEntry {
  count: number;
  windowStart: number;
}

class RateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private entries: Map<string, RateLimiterEntry>;
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = Number(options.maxRequests) > 0 ? Number(options.maxRequests) : 120;
    this.windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : 1000;
    this.entries = new Map();
    this.cleanupTimer = null;

    const cleanupIntervalMs = Number(options.cleanupIntervalMs) > 0 ? Number(options.cleanupIntervalMs) : 30000;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check whether a request from the given key (typically remote IP) should
   * be rate-limited.  Returns `true` when the caller should be rejected.
   */
  isLimited(key: string): boolean {
    if (!key) {
      return false;
    }

    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now });
      return false;
    }

    entry.count += 1;
    return entry.count > this.maxRequests;
  }

  /** Remove entries whose window has expired. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs * 2) {
        this.entries.delete(key);
      }
    }
  }

  /** Stop the background cleanup timer. */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.entries.clear();
  }
}

export { RateLimiter };
export type { RateLimiterOptions };
