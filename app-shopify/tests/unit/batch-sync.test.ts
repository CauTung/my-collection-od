/** Unit coverage for historical sync scheduling and persisted state transitions. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { scheduleJob } from "~/lib/queue.server";
import { updateCustomerSyncStateMetafields } from "~/lib/metafield.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { upsertCollectionItemByProduct } from "~/lib/metaobject.server";
import { claimOrderSync } from "~/lib/dedup.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { ORDER_LINE_ITEM_MAX_PAGES } from "~/config/constants";

vi.mock("~/lib/queue.server", () => ({ scheduleJob: vi.fn() }));
vi.mock("~/lib/metafield.server", () => ({
  updateCustomerSyncStateMetafields: vi.fn(),
  checkProductsHaveCollectibleData: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn().mockResolvedValue({ data: { orders: { nodes: [] } } }),
}));
vi.mock("~/lib/dedup.server", () => ({ claimOrderSync: vi.fn().mockResolvedValue(true) }));
vi.mock("~/lib/metaobject.server", () => ({ upsertCollectionItemByProduct: vi.fn() }));
vi.mock("~/lib/stats.server", () => ({ recalculateAndCacheStats: vi.fn() }));

const mockScheduleJob = vi.mocked(scheduleJob);
const mockUpdateSyncState = vi.mocked(updateCustomerSyncStateMetafields);
const mockCheckCollectible = vi.mocked(checkProductsHaveCollectibleData);
const mockGraphQL = vi.mocked(shopifyGraphQL);
const mockClaimOrder = vi.mocked(claimOrderSync);
const mockRecalculateStats = vi.mocked(recalculateAndCacheStats);
const CUSTOMER_GID = "gid://shopify/Customer/123";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSyncState.mockResolvedValue(undefined);
  mockCheckCollectible.mockResolvedValue([]);
  mockGraphQL.mockResolvedValue({ data: { orders: { nodes: [] } } });
  mockClaimOrder.mockResolvedValue(true);
});

describe("triggerBatchSync", () => {
  it("persists queued state before returning a queued lifecycle", async () => {
    mockScheduleJob.mockImplementationOnce(async (key, markQueued) => {
      expect(key).toBe(CUSTOMER_GID);
      await markQueued();
      return { status: "queued", completion: Promise.resolve(), isNew: true };
    });

    const scheduled = await triggerBatchSync(CUSTOMER_GID);

    expect(scheduled.status).toBe("queued");
    expect(mockUpdateSyncState).toHaveBeenCalledExactlyOnceWith(CUSTOMER_GID, {
      sync_status: "queued",
      sync_progress: { processed: 0, total: 0, failed: 0 },
    });
  });

  it("persists syncing and terminal state inside the scheduled lifecycle", async () => {
    mockScheduleJob.mockImplementationOnce((_key, _markQueued, run) => {
      const completion = run();
      return Promise.resolve({ status: "syncing", completion, isNew: true });
    });

    const scheduled = await triggerBatchSync(CUSTOMER_GID);
    await scheduled.completion;

    expect(scheduled.status).toBe("syncing");
    expect(mockUpdateSyncState.mock.calls).toEqual([
      [CUSTOMER_GID, {
        sync_status: "syncing",
        sync_progress: { processed: 0, total: 0, failed: 0 },
      }],
      [CUSTOMER_GID, {
        sync_status: "completed",
        sync_progress: { processed: 0, total: 0, failed: 0 },
      }],
    ]);
  });

  it("persists failed state when the syncing transition cannot be written", async () => {
    mockScheduleJob.mockImplementationOnce((_key, _markQueued, run) => {
      const completion = run();
      return Promise.resolve({ status: "syncing", completion, isNew: true });
    });
    mockUpdateSyncState
      .mockRejectedValueOnce(new Error("syncing state write failed"))
      .mockResolvedValueOnce(undefined);

    const scheduled = await triggerBatchSync(CUSTOMER_GID);

    await expect(scheduled.completion).rejects.toThrow("syncing state write failed");
    expect(mockUpdateSyncState.mock.calls).toEqual([
      [CUSTOMER_GID, {
        sync_status: "syncing",
        sync_progress: { processed: 0, total: 0, failed: 0 },
      }],
      [CUSTOMER_GID, {
        sync_status: "failed",
        sync_progress: { processed: 0, total: 0, failed: 0 },
      }],
    ]);
  });

  it("uses the numeric customer order filter and does not claim before product lookup", async () => {
    mockScheduleJob.mockImplementationOnce((_key, _markQueued, run) => {
      const completion = run();
      return Promise.resolve({ status: "syncing", completion, isNew: true });
    });
    mockGraphQL.mockResolvedValueOnce({
      data: {
        orders: {
          nodes: [{
            id: "gid://shopify/Order/456",
            createdAt: "2026-01-01T00:00:00Z",
            lineItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: "gid://shopify/LineItem/1",
                title: "Coin",
                quantity: 1,
                variant: { price: "10.00" },
                product: { id: "gid://shopify/Product/789", productType: "coin" },
              }],
            },
          }],
        },
      },
    });
    mockCheckCollectible.mockRejectedValueOnce(new Error("temporary product lookup failure"));

    const scheduled = await triggerBatchSync(CUSTOMER_GID);
    await scheduled.completion;

    const variables = mockGraphQL.mock.calls[0]?.[1];
    expect(variables?.query).toMatch(/^customer_id:123 AND created_at:>'/);
    expect(String(variables?.query)).not.toContain("gid://shopify/Customer");
    expect(mockClaimOrder).not.toHaveBeenCalled();
    expect(mockUpdateSyncState).toHaveBeenLastCalledWith(CUSTOMER_GID, {
      sync_status: "failed",
      sync_progress: { processed: 0, total: 0, failed: 0 },
    });
  });
});

function historicalOrder(id: number, count: number, hasNextPage: boolean, endCursor: string | null) {
  return {
    id: `gid://shopify/Order/${id}`, createdAt: "2026-01-01T00:00:00Z",
    lineItems: {
      pageInfo: { hasNextPage, endCursor },
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `gid://shopify/LineItem/${index + 1}`, title: "Coin", quantity: 1,
        variant: { price: "10.00" }, product: { id: `gid://shopify/Product/${id}`, productType: "coins" },
      })),
    },
  };
}

async function runHistoricalSync() {
  mockScheduleJob.mockImplementationOnce((_key, _markQueued, run) => {
    const completion = run();
    return Promise.resolve({ status: "syncing", completion, isNew: true });
  });
  const scheduled = await triggerBatchSync(CUSTOMER_GID);
  await scheduled.completion;
}

describe("historical order line-item pagination", () => {
  it("applies all 251 line items only after loading the continuation page", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: [historicalOrder(1, 250, true, "cursor-250")] } } });
    mockGraphQL.mockImplementationOnce(() => {
      expect(mockClaimOrder).toHaveBeenCalledTimes(0);
      expect(upsertCollectionItemByProduct).toHaveBeenCalledTimes(0);
      return Promise.resolve({ data: { order: historicalOrder(1, 1, false, null) } });
    });
    await runHistoricalSync();
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
    expect(mockGraphQL.mock.calls[1]?.[1]).toEqual({ id: "gid://shopify/Order/1", first: 250, after: "cursor-250" });
    expect(mockClaimOrder).toHaveBeenCalledExactlyOnceWith(CUSTOMER_GID, "gid://shopify/Order/1");
    expect(upsertCollectionItemByProduct).toHaveBeenCalledExactlyOnceWith(CUSTOMER_GID, "gid://shopify/Product/1", {
      quantity_owned: 251, purchase_date: "2026-01-01", purchase_price: 10,
      source: "shopify_sync", external_order_id: "gid://shopify/Order/1",
    });
  });

  it("does not claim or partially apply an order whose continuation fails while another order completes", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: [historicalOrder(1, 250, true, "cursor-250"), historicalOrder(2, 1, false, null)] } } });
    mockGraphQL.mockRejectedValueOnce(new Error("continuation failed"));
    await runHistoricalSync();
    expect(mockClaimOrder).toHaveBeenCalledExactlyOnceWith(CUSTOMER_GID, "gid://shopify/Order/2");
    expect(upsertCollectionItemByProduct).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertCollectionItemByProduct).mock.calls[0]?.[1]).toBe("gid://shopify/Product/2");
    expect(mockUpdateSyncState).toHaveBeenLastCalledWith(CUSTOMER_GID, {
      sync_status: "failed", sync_progress: { processed: 2, total: 3, failed: 1 },
    });
  });

  it.each([null, "cursor-250"])("rejects missing or repeated continuation cursor %s before claiming", async (cursor) => {
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: [historicalOrder(1, 250, true, "cursor-250")] } } });
    mockGraphQL.mockResolvedValueOnce({ data: { order: historicalOrder(1, 1, true, cursor) } });
    await runHistoricalSync();
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
    expect(mockClaimOrder).toHaveBeenCalledTimes(0);
    expect(upsertCollectionItemByProduct).toHaveBeenCalledTimes(0);
    expect(mockUpdateSyncState).toHaveBeenLastCalledWith(CUSTOMER_GID, {
      sync_status: "failed", sync_progress: { processed: 0, total: 1, failed: 1 },
    });
  });

  it("processes an order with exactly 250 items in a single query without continuation", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: [historicalOrder(1, 250, false, null)] } } });
    await runHistoricalSync();
    expect(mockGraphQL).toHaveBeenCalledTimes(1);
    expect(mockClaimOrder).toHaveBeenCalledExactlyOnceWith(CUSTOMER_GID, "gid://shopify/Order/1");
    expect(upsertCollectionItemByProduct).toHaveBeenCalledExactlyOnceWith(CUSTOMER_GID, "gid://shopify/Product/1", {
      quantity_owned: 250, purchase_date: "2026-01-01", purchase_price: 10,
      source: "shopify_sync", external_order_id: "gid://shopify/Order/1",
    });
  });

  it("isolates and rejects an order exceeding the maximum line-item page limit", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: [historicalOrder(1, 250, true, "cursor-1")] } } });
    for (let p = 1; p <= ORDER_LINE_ITEM_MAX_PAGES; p++) {
      mockGraphQL.mockResolvedValueOnce({ data: { order: historicalOrder(1, 1, true, `cursor-${p + 1}`) } });
    }
    await runHistoricalSync();
    expect(mockClaimOrder).toHaveBeenCalledTimes(0);
    expect(upsertCollectionItemByProduct).toHaveBeenCalledTimes(0);
    expect(mockUpdateSyncState).toHaveBeenLastCalledWith(CUSTOMER_GID, {
      sync_status: "failed", sync_progress: { processed: 0, total: 1, failed: 1 },
    });
  });

  it("recalculates stats on retry when all orders were already claimed and no new coins claimed", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { orders: { nodes: [historicalOrder(1, 1, false, null)] } } });
    mockClaimOrder.mockResolvedValueOnce(false); // already claimed
    await runHistoricalSync();
    expect(mockClaimOrder).toHaveBeenCalledTimes(1);
    expect(upsertCollectionItemByProduct).toHaveBeenCalledTimes(0);
    expect(mockRecalculateStats).toHaveBeenCalledTimes(1);
    expect(mockRecalculateStats).toHaveBeenCalledWith(CUSTOMER_GID);
    expect(mockUpdateSyncState).toHaveBeenLastCalledWith(CUSTOMER_GID, {
      sync_status: "completed", sync_progress: { processed: 1, total: 1, failed: 0 },
    });
  });
});
