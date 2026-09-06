/** Unit coverage for historical sync scheduling and persisted state transitions. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { scheduleJob } from "~/lib/queue.server";
import { updateCustomerSyncStateMetafields } from "~/lib/metafield.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { claimOrderSync } from "~/lib/dedup.server";

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
