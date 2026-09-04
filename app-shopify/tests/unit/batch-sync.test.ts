/**
 * tests/unit/batch-sync.test.ts
 *
 * Unit tests for the historical batch sync engine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { acquireJobSlot } from "~/lib/queue.server";
import { updateCustomerSyncStateMetafields } from "~/lib/metafield.server";

// Mock dependencies
vi.mock("~/lib/queue.server", () => ({
  acquireJobSlot: vi.fn(),
  releaseJobSlot: vi.fn(),
  resetJobCounter: vi.fn(),
}));

vi.mock("~/lib/metafield.server", () => ({
  updateCustomerSyncStateMetafields: vi.fn(),
  filterCoinLineItems: vi.fn(),
  checkProductsHaveCollectibleData: vi.fn().mockResolvedValue([]),
}));

vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn().mockResolvedValue({ data: { orders: { nodes: [] } } }),
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

const mockAcquireJobSlot = vi.mocked(acquireJobSlot);
const mockUpdateSyncState = vi.mocked(updateCustomerSyncStateMetafields);

const CUSTOMER_GID = "gid://shopify/Customer/123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("triggerBatchSync", () => {
  it("returns 'queued' and updates state if job slot cannot be acquired", async () => {
    mockAcquireJobSlot.mockReturnValue(false); // System at max capacity

    const result = await triggerBatchSync(CUSTOMER_GID);

    expect(result).toBe("queued");
    expect(mockUpdateSyncState).toHaveBeenCalledWith(CUSTOMER_GID, { sync_status: "queued" });
  });

  it("returns 'syncing' and updates state if job slot is acquired", async () => {
    mockAcquireJobSlot.mockReturnValue(true);

    const result = await triggerBatchSync(CUSTOMER_GID);

    expect(result).toBe("syncing");
    expect(mockUpdateSyncState).toHaveBeenCalledWith(CUSTOMER_GID, {
      sync_status: "syncing",
    });
  });
});
