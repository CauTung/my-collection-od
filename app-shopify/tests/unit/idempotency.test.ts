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
  releaseIdempotencyClaim,
  clearIdempotencyCache,
  getIdempotencyCacheSize,
} from "~/lib/idempotency.server";

const CUSTOMER_A_CREATE = {
  customerId: "gid://shopify/Customer/111",
  operation: "create" as const,
};

beforeEach(() => {
  // Reset cache between tests for isolation
  clearIdempotencyCache();
});

describe("idempotency cache", () => {
  it("returns 'claimed' for a key that has never been seen", () => {
    const result = checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, "never-seen-key-uuid-1234");
    expect(result).toEqual({ status: "claimed" });
  });

  it("returns 'finished' and the stored result for a key that was completed", () => {
    const key = "idem-key-abc";
    const stored = { item_id: "item_001", status: "created" };

    setIdempotentResult(CUSTOMER_A_CREATE, key, stored);
    const retrieved = checkAndClaimIdempotencyKey<typeof stored>(CUSTOMER_A_CREATE, key);

    expect(retrieved).toEqual({ status: "finished", result: stored });
  });

  it("double-submit: returns 'processing' if the key was claimed but not yet finished", () => {
    const key = "idem-key-double-submit";

    // First request claims the key
    const firstResult = checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key);
    expect(firstResult).toEqual({ status: "claimed" });

    // Second request (the double-submit) should see 'processing' before the first finishes
    const secondResult = checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key);
    expect(secondResult).toEqual({ status: "processing" });

    // The cache should not grow — same key
    expect(getIdempotencyCacheSize()).toBe(1);
  });

  it("different keys are stored independently", () => {
    const key1 = "key-001";
    const key2 = "key-002";

    setIdempotentResult(CUSTOMER_A_CREATE, key1, { item: "A" });
    setIdempotentResult(CUSTOMER_A_CREATE, key2, { item: "B" });

    expect(checkAndClaimIdempotencyKey<{ item: string }>(CUSTOMER_A_CREATE, key1)).toEqual({ status: "finished", result: { item: "A" } });
    expect(checkAndClaimIdempotencyKey<{ item: string }>(CUSTOMER_A_CREATE, key2)).toEqual({ status: "finished", result: { item: "B" } });
    expect(getIdempotencyCacheSize()).toBe(2);
  });

  it("returns 'claimed' for an expired key (past TTL)", () => {
    const key = "expired-key";

    // Use fake timers to simulate TTL expiry
    vi.useFakeTimers();

    setIdempotentResult(CUSTOMER_A_CREATE, key, { data: "something" });

    // Advance time beyond TTL (5 minutes + 1 second)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

    const result = checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key);

    vi.useRealTimers();

    expect(result).toEqual({ status: "claimed" });
  });

  it("returns 'finished' before TTL expires", () => {
    const key = "fresh-key";
    const stored = { status: "ok" };

    vi.useFakeTimers();
    setIdempotentResult(CUSTOMER_A_CREATE, key, stored);

    // Advance time to just before TTL
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 minutes — within 5-minute TTL

    const result = checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key);

    vi.useRealTimers();

    expect(result).toEqual({ status: "finished", result: stored });
  });

  it("clearIdempotencyCache removes all entries", () => {
    setIdempotentResult(CUSTOMER_A_CREATE, "key-a", { data: 1 });
    setIdempotentResult(CUSTOMER_A_CREATE, "key-b", { data: 2 });
    expect(getIdempotencyCacheSize()).toBe(2);

    clearIdempotencyCache();
    expect(getIdempotencyCacheSize()).toBe(0);
  });

  it("does not share a completed key between two authenticated customers", () => {
    const sharedKey = "same-client-generated-uuid";
    const customerBCreate = {
      customerId: "gid://shopify/Customer/222",
      operation: "create" as const,
    };

    setIdempotentResult(CUSTOMER_A_CREATE, sharedKey, { item: "customer-a-item" });

    expect(checkAndClaimIdempotencyKey(customerBCreate, sharedKey)).toEqual({
      status: "claimed",
    });
    setIdempotentResult(customerBCreate, sharedKey, { item: "customer-b-item" });

    expect(
      checkAndClaimIdempotencyKey<{ item: string }>(CUSTOMER_A_CREATE, sharedKey)
    ).toEqual({ status: "finished", result: { item: "customer-a-item" } });
    expect(
      checkAndClaimIdempotencyKey<{ item: string }>(customerBCreate, sharedKey)
    ).toEqual({ status: "finished", result: { item: "customer-b-item" } });
    expect(getIdempotencyCacheSize()).toBe(2);
  });

  it("does not share a key between create and update operations", () => {
    const sharedKey = "same-key-for-different-operations";
    const updateScope = {
      customerId: CUSTOMER_A_CREATE.customerId,
      operation: "update" as const,
      resourceId: "item-001",
    };

    setIdempotentResult(CUSTOMER_A_CREATE, sharedKey, { operation: "create" });

    expect(checkAndClaimIdempotencyKey(updateScope, sharedKey)).toEqual({ status: "claimed" });
    expect(getIdempotencyCacheSize()).toBe(2);
  });

  it("allows the same request to retry after a failed processing claim is released", () => {
    const key = "retry-after-failure";

    expect(checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key)).toEqual({
      status: "claimed",
    });
    releaseIdempotencyClaim(CUSTOMER_A_CREATE, key);

    expect(checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key)).toEqual({
      status: "claimed",
    });
    expect(getIdempotencyCacheSize()).toBe(1);
  });

  it("does not remove a completed result when release is called late", () => {
    const key = "completed-result";
    const result = { item: "created-item" };

    setIdempotentResult(CUSTOMER_A_CREATE, key, result);
    releaseIdempotencyClaim(CUSTOMER_A_CREATE, key);

    expect(checkAndClaimIdempotencyKey(CUSTOMER_A_CREATE, key)).toEqual({
      status: "finished",
      result,
    });
  });
});
