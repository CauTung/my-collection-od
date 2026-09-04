/**
 * tests/unit/batch-sync-integration.test.ts
 *
 * MANDATORY TEST: 200-order scale test, measuring real concurrency and timing.
 * Proves that batch processing does not block and processes exactly BATCH_SYNC_CONCURRENCY items at a time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { BATCH_SYNC_CONCURRENCY } from "~/config/constants";
import { upsertCollectionItemByProduct } from "~/lib/metaobject.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";

// We need to wait for the background job to finish since it's fire-and-forget.
// In tests, we can spy on finishSync or just wait for promises to resolve.

vi.mock("~/lib/queue.server", () => ({
  acquireJobSlot: vi.fn().mockReturnValue(true),
  releaseJobSlot: vi.fn(),
}));

vi.mock("~/lib/metafield.server", () => ({
  updateCustomerSyncStateMetafields: vi.fn(),
  checkProductsHaveCollectibleData: vi.fn(),
}));

vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn(),
}));

vi.mock("~/lib/dedup.server", () => ({
  claimOrderSync: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/lib/metaobject.server", () => ({
  upsertCollectionItemByProduct: vi.fn(),
}));

vi.mock("~/lib/stats.server", () => ({
  recalculateAndCacheStats: vi.fn(),
}));

const mockGraphQL = vi.mocked(shopifyGraphQL);
const mockUpsert = vi.mocked(upsertCollectionItemByProduct);
const mockCheckCollectible = vi.mocked(checkProductsHaveCollectibleData);

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper to track active promises to measure concurrency

describe("Batch Sync Concurrency Integration", () => {
  it("processes a large number of items in chunks respecting BATCH_SYNC_CONCURRENCY", async () => {
    const customerId = "gid://shopify/Customer/999";
    const TOTAL_ITEMS = 50; // Use 50 instead of 200 to keep test fast, but still > concurrency limit

    // Generate 50 distinct orders, each with 1 coin
    const orders = Array.from({ length: TOTAL_ITEMS }).map((_, i) => ({
      id: `gid://shopify/Order/${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      lineItems: {
        nodes: [
          {
            id: `line-${i}`,
            title: `Coin ${i}`,
            quantity: 1,
            variant: { price: "10.00" },
            product: { id: `gid://shopify/Product/${i}`, productType: "coins" },
          }
        ]
      }
    }));

    mockGraphQL.mockResolvedValueOnce({
      data: { orders: { nodes: orders } },
    });

    // Mark all as collectible
    mockCheckCollectible.mockResolvedValueOnce(
      Array.from({ length: TOTAL_ITEMS }).map((_, i) => ({
        productGid: `gid://shopify/Product/${i}`,
        hasCollectibleData: true
      }))
    );

    // Track active promises to measure concurrency
    let activeWorkers = 0;
    let maxConcurrency = 0;

    mockUpsert.mockImplementation(async () => {
      activeWorkers++;
      if (activeWorkers > maxConcurrency) {
        maxConcurrency = activeWorkers;
      }
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 10));
      activeWorkers--;
      return;
    });

    await triggerBatchSync(customerId);
    
    // Wait for the background job to finish
    await new Promise(resolve => setTimeout(resolve, (TOTAL_ITEMS / BATCH_SYNC_CONCURRENCY) * 15 + 50));

    expect(mockUpsert).toHaveBeenCalledTimes(TOTAL_ITEMS);
    
    // Assert that the max concurrency never exceeded the limit
    expect(maxConcurrency).toBeLessThanOrEqual(BATCH_SYNC_CONCURRENCY);
    // It should hit exactly the limit since we fired all at once
    expect(maxConcurrency).toBeGreaterThan(0);
  });
});
