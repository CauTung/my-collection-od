/**
 * tests/unit/idempotency.test.ts
 *
 * Tests for the in-process idempotency key cache.
 * Verifies that double-submit with the same key only processes the request once.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkAndClaimIdempotencyKey,
  setIdempotentResult,
  clearIdempotencyCache,
  getIdempotencyCacheSize,
} from "~/lib/idempotency.server";

beforeEach(() => {
  // Reset cache between tests for isolation
  clearIdempotencyCache();
});

describe("idempotency cache", () => {
  it("returns 'claimed' for a key that has never been seen", () => {
    const result = checkAndClaimIdempotencyKey("never-seen-key-uuid-1234");
    expect(result).toEqual({ status: "claimed" });
  });

  it("returns 'finished' and the stored result for a key that was completed", () => {
    const key = "idem-key-abc";
    const stored = { item_id: "item_001", status: "created" };

    setIdempotentResult(key, stored);
    const retrieved = checkAndClaimIdempotencyKey<typeof stored>(key);

    expect(retrieved).toEqual({ status: "finished", result: stored });
  });

  it("double-submit: returns 'processing' if the key was claimed but not yet finished", () => {
    const key = "idem-key-double-submit";

    // First request claims the key
    const firstResult = checkAndClaimIdempotencyKey(key);
    expect(firstResult).toEqual({ status: "claimed" });

    // Second request (the double-submit) should see 'processing' before the first finishes
    const secondResult = checkAndClaimIdempotencyKey(key);
    expect(secondResult).toEqual({ status: "processing" });

    // The cache should not grow — same key
    expect(getIdempotencyCacheSize()).toBe(1);
  });

  it("different keys are stored independently", () => {
    const key1 = "key-001";
    const key2 = "key-002";

    setIdempotentResult(key1, { item: "A" });
    setIdempotentResult(key2, { item: "B" });

    expect(checkAndClaimIdempotencyKey<{ item: string }>(key1)).toEqual({ status: "finished", result: { item: "A" } });
    expect(checkAndClaimIdempotencyKey<{ item: string }>(key2)).toEqual({ status: "finished", result: { item: "B" } });
    expect(getIdempotencyCacheSize()).toBe(2);
  });

  it("returns 'claimed' for an expired key (past TTL)", () => {
    const key = "expired-key";

    // Use fake timers to simulate TTL expiry
    vi.useFakeTimers();

    setIdempotentResult(key, { data: "something" });

    // Advance time beyond TTL (5 minutes + 1 second)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

    const result = checkAndClaimIdempotencyKey(key);

    vi.useRealTimers();

    expect(result).toEqual({ status: "claimed" });
  });

  it("returns 'finished' before TTL expires", () => {
    const key = "fresh-key";
    const stored = { status: "ok" };

    vi.useFakeTimers();
    setIdempotentResult(key, stored);

    // Advance time to just before TTL
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 minutes — within 5-minute TTL

    const result = checkAndClaimIdempotencyKey(key);

    vi.useRealTimers();

    expect(result).toEqual({ status: "finished", result: stored });
  });

  it("clearIdempotencyCache removes all entries", () => {
    setIdempotentResult("key-a", { data: 1 });
    setIdempotentResult("key-b", { data: 2 });
    expect(getIdempotencyCacheSize()).toBe(2);

    clearIdempotencyCache();
    expect(getIdempotencyCacheSize()).toBe(0);
  });
});
