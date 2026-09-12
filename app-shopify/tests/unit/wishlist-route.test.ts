import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.collection.$item_id.wishlist";
import { getCollectionItem, updateCollectionItem } from "~/lib/metaobject.server";
import type { CollectionItem } from "~/types";

const { mockAddToWishlist, mockRemoveFromWishlist } = vi.hoisted(() => ({
  mockAddToWishlist: vi.fn(),
  mockRemoveFromWishlist: vi.fn(),
}));

vi.mock("~/lib/metaobject.server", () => ({
  getCollectionItem: vi.fn(),
  updateCollectionItem: vi.fn(),
}));

vi.mock("~/lib/integrations/wishlist-adapter", () => ({
  wishlistAdapter: {
    addToWishlist: mockAddToWishlist,
    removeFromWishlist: mockRemoveFromWishlist,
    isInWishlist: vi.fn(),
  },
}));

const TEST_SECRET = "wishlist_route_secret";
const CUSTOMER_ID = "gid://shopify/Customer/12345";
const ITEM: CollectionItem = {
  item_id: "item-1",
  customer_id: CUSTOMER_ID,
  product_id: "gid://shopify/Product/999",
  source: "manual_entry",
  quantity_owned: 1,
  date_added_to_collection: "2026-09-12",
  in_wishlist: false,
  is_deleted: false,
};

const mockGetCollectionItem = vi.mocked(getCollectionItem);
const mockUpdateCollectionItem = vi.mocked(updateCollectionItem);

function createSignedRequest(method: "POST" | "DELETE"): Request {
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
  return new Request(`https://app.example.com/api/collection/item-1/wishlist?${query.toString()}`, { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_SECRET = TEST_SECRET;
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
  mockGetCollectionItem.mockResolvedValue(ITEM);
  mockUpdateCollectionItem.mockImplementation((_customerId, _itemId, updates) => Promise.resolve({
    ...ITEM,
    ...updates,
  }));
});

describe("wishlist route persistence", () => {
  it("persists and returns the wishlist state after the adapter succeeds", async () => {
    const response = await action({
      request: createSignedRequest("POST"),
      params: { item_id: ITEM.item_id },
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    expect(mockGetCollectionItem).toHaveBeenCalledWith(CUSTOMER_ID, ITEM.item_id);
    expect(mockAddToWishlist).toHaveBeenCalledWith(CUSTOMER_ID, ITEM.product_id);
    expect(mockUpdateCollectionItem).toHaveBeenCalledWith(CUSTOMER_ID, ITEM.item_id, { in_wishlist: true });
    expect(await response.json()).toEqual({
      success: true,
      message: "Added to wishlist",
      data: { ...ITEM, in_wishlist: true },
    });
  });

  it("persists and returns the unwishlist state after the adapter succeeds", async () => {
    mockGetCollectionItem.mockResolvedValueOnce({ ...ITEM, in_wishlist: true });
    const response = await action({
      request: createSignedRequest("DELETE"),
      params: { item_id: ITEM.item_id },
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    expect(mockRemoveFromWishlist).toHaveBeenCalledWith(CUSTOMER_ID, ITEM.product_id);
    expect(mockUpdateCollectionItem).toHaveBeenCalledWith(CUSTOMER_ID, ITEM.item_id, { in_wishlist: false });
    expect(await response.json()).toEqual({
      success: true,
      message: "Removed from wishlist",
      data: { ...ITEM, in_wishlist: false },
    });
  });

  it("does not persist native state when the wishlist adapter fails", async () => {
    mockAddToWishlist.mockRejectedValueOnce(new Error("adapter unavailable"));
    const response = await action({
      request: createSignedRequest("POST"),
      params: { item_id: ITEM.item_id },
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(500);
    expect(mockAddToWishlist).toHaveBeenCalledTimes(1);
    expect(mockUpdateCollectionItem).toHaveBeenCalledTimes(0);
    expect(await response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  it("returns an infrastructure error when native persistence fails after the adapter succeeds", async () => {
    mockUpdateCollectionItem.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const response = await action({
      request: createSignedRequest("POST"),
      params: { item_id: ITEM.item_id },
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(500);
    expect(mockAddToWishlist).toHaveBeenCalledTimes(1);
    expect(mockUpdateCollectionItem).toHaveBeenCalledTimes(1);
    expect(mockAddToWishlist.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateCollectionItem.mock.invocationCallOrder[0]
    );
    expect(await response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  it("does not persist native state when the unwishlist adapter fails", async () => {
    mockGetCollectionItem.mockResolvedValueOnce({ ...ITEM, in_wishlist: true });
    mockRemoveFromWishlist.mockRejectedValueOnce(new Error("adapter unavailable"));
    const response = await action({
      request: createSignedRequest("DELETE"),
      params: { item_id: ITEM.item_id },
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(500);
    expect(mockRemoveFromWishlist).toHaveBeenCalledTimes(1);
    expect(mockUpdateCollectionItem).toHaveBeenCalledTimes(0);
    expect(await response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  it("returns an infrastructure error when unwishlist persistence fails after the adapter succeeds", async () => {
    mockGetCollectionItem.mockResolvedValueOnce({ ...ITEM, in_wishlist: true });
    mockUpdateCollectionItem.mockRejectedValueOnce(new Error("Shopify unavailable"));
    const response = await action({
      request: createSignedRequest("DELETE"),
      params: { item_id: ITEM.item_id },
    } as unknown as Parameters<typeof action>[0]);

    expect(response.status).toBe(500);
    expect(mockRemoveFromWishlist).toHaveBeenCalledTimes(1);
    expect(mockUpdateCollectionItem).toHaveBeenCalledTimes(1);
    expect(mockRemoveFromWishlist.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateCollectionItem.mock.invocationCallOrder[0]
    );
    expect(await response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });
});
