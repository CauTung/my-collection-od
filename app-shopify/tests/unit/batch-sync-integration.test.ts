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
import { claimOrderSync } from "~/lib/dedup.server";

// We need to wait for the background job to finish since it's fire-and-forget.
// In tests, we can spy on finishSync or just wait for promises to resolve.

vi.mock("~/lib/queue.server", () => ({
  scheduleJob: vi.fn((_key: string, _markQueued: () => Promise<void>, run: () => Promise<void>) => {
    const completion = run();
    return Promise.resolve({ status: "syncing" as const, completion, isNew: true });
  }),
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
const mockClaimOrder = vi.mocked(claimOrderSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockClaimOrder.mockResolvedValue(true);
  mockUpsert.mockResolvedValue(undefined);
});

// Helper to track active promises to measure concurrency

describe("Batch Sync Concurrency Integration", () => {
  it("processes a large number of items in chunks respecting BATCH_SYNC_CONCURRENCY", async () => {
    const customerId = "gid://shopify/Customer/999";
    const TOTAL_ITEMS = 200;

    // Generate 50 distinct orders, each with 1 coin
    const orders = Array.from({ length: TOTAL_ITEMS }).map((_, i) => ({
      id: `gid://shopify/Order/${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      lineItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
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

    const scheduled = await triggerBatchSync(customerId);
    await scheduled.completion;

    expect(mockUpsert).toHaveBeenCalledTimes(TOTAL_ITEMS);
    
    // Assert that the max concurrency never exceeded the limit
    expect(maxConcurrency).toBe(BATCH_SYNC_CONCURRENCY);
  });

  it("claims exactly five orders concurrently after product prerequisites succeed", async () => {
    const customerId = "gid://shopify/Customer/999";
    const orderCount = 12;
    const orders = Array.from({ length: orderCount }, (_, index) => ({
      id: `gid://shopify/Order/${index + 1}`,
      createdAt: "2026-01-01T00:00:00Z",
      lineItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: `gid://shopify/LineItem/${index + 1}`,
          title: `Coin ${index + 1}`,
          quantity: 1,
          variant: { price: "10.00" },
          product: {
            id: `gid://shopify/Product/${index + 1}`,
            productType: "coins",
          },
        }],
      },
    }));
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: orders } } });
    mockCheckCollectible.mockResolvedValueOnce(orders.map((order) => ({
      productGid: order.lineItems.nodes[0].product.id,
      hasCollectibleData: true,
    })));

    let releaseClaims: (() => void) | undefined;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    let activeClaims = 0;
    let maximumClaims = 0;
    mockClaimOrder.mockImplementation(async () => {
      activeClaims += 1;
      maximumClaims = Math.max(maximumClaims, activeClaims);
      await claimGate;
      activeClaims -= 1;
      return true;
    });

    const scheduled = await triggerBatchSync(customerId);
    await vi.waitFor(() => expect(maximumClaims).toBe(BATCH_SYNC_CONCURRENCY));
    releaseClaims?.();
    await scheduled.completion;

    expect(mockClaimOrder).toHaveBeenCalledTimes(orderCount);
    expect(maximumClaims).toBe(BATCH_SYNC_CONCURRENCY);
  });
});
