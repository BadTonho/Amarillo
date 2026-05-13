"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RateLimiter } = require("../src/daemon/lib/rate-limiter");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("RateLimiter allows requests up to the configured window limit", () => {
  const limiter = new RateLimiter({
    maxRequests: 2,
    windowMs: 1000,
    cleanupIntervalMs: 10000
  });

  try {
    assert.equal(limiter.isLimited("127.0.0.1"), false);
    assert.equal(limiter.isLimited("127.0.0.1"), false);
    assert.equal(limiter.isLimited("127.0.0.1"), true);
    assert.equal(limiter.isLimited("127.0.0.2"), false);
  } finally {
    limiter.dispose();
  }
});

test("RateLimiter opens a fresh window after the configured duration", async () => {
  const limiter = new RateLimiter({
    maxRequests: 1,
    windowMs: 20,
    cleanupIntervalMs: 10000
  });

  try {
    assert.equal(limiter.isLimited("127.0.0.1"), false);
    assert.equal(limiter.isLimited("127.0.0.1"), true);
    await wait(30);
    assert.equal(limiter.isLimited("127.0.0.1"), false);
  } finally {
    limiter.dispose();
  }
});

