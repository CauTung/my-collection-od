/** Lifecycle regression tests for the orders/paid webhook. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.webhooks.orders-paid";
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import { claimOrderSync, isOrderSyncClaimed } from "~/lib/dedup.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { upsertCollectionItemByProduct } from "~/lib/metaobject.server";

vi.mock("~/lib/webhook.server", () => ({ authenticateWebhookRequest: vi.fn() }));
vi.mock("~/lib/dedup.server", () => ({
  claimOrderSync: vi.fn(),
  isOrderSyncClaimed: vi.fn(),
}));
vi.mock("~/lib/metafield.server", () => ({
  checkProductsHaveCollectibleData: vi.fn(),
}));
vi.mock("~/lib/metaobject.server", () => ({
  upsertCollectionItemByProduct: vi.fn(),
}));
vi.mock("~/lib/stats.server", () => ({
  recalculateAndCacheStats: vi.fn().mockResolvedValue(undefined),
}));

const mockAuthenticate = vi.mocked(authenticateWebhookRequest);
const mockClaim = vi.mocked(claimOrderSync);
const mockIsClaimed = vi.mocked(isOrderSyncClaimed);
const mockCheckCollectible = vi.mocked(checkProductsHaveCollectibleData);
const mockUpsert = vi.mocked(upsertCollectionItemByProduct);

const payload = {
  id: 1001,
  order_number: 1001,
  created_at: "2026-09-05T00:00:00Z",
  financial_status: "paid",
  customer: { id: 2002 },
  line_items: [
    {
      id: 3003,
      product_id: 4004,
      variant_id: 5005,
      title: "Collectible coin",
      quantity: 1,
      price: "25.00",
      sku: "COIN-1",
      vendor: "Downies",
      product_type: "coin",
      properties: [],
    },
  ],
};

function invoke(): Promise<Response> {
  return action({
    request: new Request("https://app.example.com/api/webhooks/orders-paid", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue(payload);
  mockCheckCollectible.mockResolvedValue([]);
  mockClaim.mockResolvedValue(true);
  mockIsClaimed.mockResolvedValue(false);
  mockUpsert.mockResolvedValue(undefined);
});

describe("orders/paid webhook lifecycle", () => {
  it("does not recreate collection items when cancellation arrived first", async () => {
    mockIsClaimed.mockResolvedValueOnce(true);

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(mockIsClaimed).toHaveBeenCalledWith(
      "gid://shopify/Customer/2002",
      "gid://shopify/Order/1001-cancel"
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("does not claim an order when collectible-data lookup fails", async () => {
    mockCheckCollectible.mockRejectedValueOnce(new Error("temporary Shopify failure"));

    const response = await invoke();

    expect(response.status).toBe(500);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
