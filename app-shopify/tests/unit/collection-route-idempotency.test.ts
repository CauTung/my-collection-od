/**
 * tests/unit/collection-route-idempotency.test.ts
 *
 * Proves that a failed manual mutation releases its processing claim so the exact same
 * authenticated request can retry instead of remaining blocked until cache expiry.
 */

import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action as collectionAction } from "~/routes/api.collection";
import { action as itemAction } from "~/routes/api.collection.$item_id";
import {
  createCollectionItem,
  updateCollectionItem,
} from "~/lib/metaobject.server";
import { clearIdempotencyCache } from "~/lib/idempotency.server";

vi.mock("~/lib/metaobject.server", () => ({
  createCollectionItem: vi.fn(),
  deleteCollectionItem: vi.fn(),
  listCollectionItems: vi.fn(),
  updateCollectionItem: vi.fn(),
}));

vi.mock("~/lib/stats.server", () => ({
  recalculateAndCacheStats: vi.fn().mockResolvedValue(undefined),
}));

const TEST_SECRET = "route_idempotency_secret";
const CUSTOMER_ID = "gid://shopify/Customer/12345";
const IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";
const mockCreateCollectionItem = vi.mocked(createCollectionItem);
const mockUpdateCollectionItem = vi.mocked(updateCollectionItem);

function createSignedMutationRequest(path: string, method: "POST" | "PUT", body: unknown): Request {
  const parameters: Record<string, string> = {
    logged_in_customer_id: "12345",
    path_prefix: "/apps/my-collection",
    shop: "test-shop.myshopify.com",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const message = Object.entries(parameters)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  const signature = createHmac("sha256", TEST_SECRET).update(message).digest("hex");
  const query = new URLSearchParams({ ...parameters, signature });

  return new Request(`https://app.example.com${path}?${query.toString()}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  clearIdempotencyCache();
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_SECRET = TEST_SECRET;
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
});

describe("manual mutation idempotency failure lifecycle", () => {
  it("retries a create after the first Shopify mutation fails", async () => {
    mockCreateCollectionItem
      .mockRejectedValueOnce(new Error("temporary Shopify failure"))
      .mockResolvedValueOnce({
        item_id: "item-1",
        customer_id: CUSTOMER_ID,
        product_id: "gid://shopify/Product/999",
        source: "manual_entry",
        quantity_owned: 1,
        date_added_to_collection: "2026-09-05",
        in_wishlist: false,
        is_deleted: false,
      });
    const body = {
      idempotency_key: IDEMPOTENCY_KEY,
      product_id: "gid://shopify/Product/999",
      quantity_owned: 1,
      in_wishlist: false,
    };

    const firstResponse = await collectionAction({
      request: createSignedMutationRequest("/api/collection", "POST", body),
    } as Parameters<typeof collectionAction>[0]);
    const retryResponse = await collectionAction({
      request: createSignedMutationRequest("/api/collection", "POST", body),
    } as Parameters<typeof collectionAction>[0]);

    expect(firstResponse.status).toBe(500);
    expect(retryResponse.status).toBe(201);
    expect(mockCreateCollectionItem).toHaveBeenCalledTimes(2);
  });

  it("retries an update after the first Shopify mutation fails", async () => {
    mockUpdateCollectionItem
      .mockRejectedValueOnce(new Error("temporary Shopify failure"))
      .mockResolvedValueOnce({
        item_id: "item-1",
        customer_id: CUSTOMER_ID,
        product_id: "gid://shopify/Product/999",
        source: "manual_entry",
        quantity_owned: 2,
        date_added_to_collection: "2026-09-05",
        in_wishlist: false,
        is_deleted: false,
      });
    const body = {
      idempotency_key: IDEMPOTENCY_KEY,
      quantity_owned: 2,
    };

    const firstResponse = await itemAction({
      request: createSignedMutationRequest("/api/collection/item-1", "PUT", body),
      params: { item_id: "item-1" },
    } as unknown as Parameters<typeof itemAction>[0]);
    const retryResponse = await itemAction({
      request: createSignedMutationRequest("/api/collection/item-1", "PUT", body),
      params: { item_id: "item-1" },
    } as unknown as Parameters<typeof itemAction>[0]);

    expect(firstResponse.status).toBe(500);
    expect(retryResponse.status).toBe(200);
    expect(mockUpdateCollectionItem).toHaveBeenCalledTimes(2);
  });
});
