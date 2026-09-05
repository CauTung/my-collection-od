/** Route-level lifecycle coverage for refund customer resolution and decrement. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.webhooks.refunds-create";
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import { getOrderCustomerId } from "~/lib/order.server";
import { claimOrderSync } from "~/lib/dedup.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { decrementCollectionItemByProduct } from "~/lib/metaobject.server";

vi.mock("~/lib/webhook.server", () => ({ authenticateWebhookRequest: vi.fn() }));
vi.mock("~/lib/order.server", () => ({ getOrderCustomerId: vi.fn() }));
vi.mock("~/lib/dedup.server", () => ({ claimOrderSync: vi.fn() }));
vi.mock("~/lib/metafield.server", () => ({ checkProductsHaveCollectibleData: vi.fn() }));
vi.mock("~/lib/metaobject.server", () => ({ decrementCollectionItemByProduct: vi.fn() }));
vi.mock("~/lib/stats.server", () => ({
  recalculateAndCacheStats: vi.fn().mockResolvedValue(undefined),
}));

const mockAuthenticate = vi.mocked(authenticateWebhookRequest);
const mockGetCustomer = vi.mocked(getOrderCustomerId);
const mockClaim = vi.mocked(claimOrderSync);
const mockCheckCollectible = vi.mocked(checkProductsHaveCollectibleData);
const mockDecrement = vi.mocked(decrementCollectionItemByProduct);

function invoke(): Promise<Response> {
  return action({
    request: new Request("https://app.example.com/api/webhooks/refunds-create", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({
    id: 700,
    order_id: 800,
    created_at: "2026-09-05T00:00:00Z",
    refund_line_items: [{
      id: 900,
      quantity: 2,
      line_item_id: 901,
      line_item: {
        id: 901,
        product_id: 902,
        variant_id: 903,
        title: "Collectible coin",
        quantity: 2,
        price: "25.00",
        sku: "COIN-1",
        vendor: "Downies",
        product_type: "coin",
        properties: [],
      },
    }],
  });
  mockGetCustomer.mockResolvedValue("gid://shopify/Customer/600");
  mockCheckCollectible.mockResolvedValue([
    { productGid: "gid://shopify/Product/902", hasCollectibleData: true },
  ]);
  mockClaim.mockResolvedValue(true);
  mockDecrement.mockResolvedValue(undefined);
});

describe("refunds/create webhook lifecycle", () => {
  it("resolves the order customer, claims the refund, and decrements exact quantity", async () => {
    const response = await invoke();

    expect(response.status).toBe(200);
    expect(mockGetCustomer).toHaveBeenCalledWith("gid://shopify/Order/800");
    expect(mockClaim).toHaveBeenCalledWith("gid://shopify/Customer/600", "refund-700");
    expect(mockDecrement).toHaveBeenCalledWith(
      "gid://shopify/Customer/600",
      "gid://shopify/Product/902",
      2
    );
  });
});
