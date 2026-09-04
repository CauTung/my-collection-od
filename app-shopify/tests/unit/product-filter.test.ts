/**
 * tests/unit/product-filter.test.ts
 *
 * Tests for the coin vs accessory classifier.
 * Critical: must cover the case where collectibleProductIds is empty
 * to confirm the fallback behavior is understood: it must prioritize collectible ID sets.
 */

import { describe, it, expect } from "vitest";
import { filterCoinLineItems, buildCollectibleProductIds } from "~/lib/product-filter.server";
import type { ShopifyLineItem } from "~/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLineItem(overrides: Partial<ShopifyLineItem>): ShopifyLineItem {
  return {
    id: 1,
    product_id: 100,
    variant_id: 200,
    title: "2024 Silver Coin",
    quantity: 1,
    price: "150.00",
    sku: "COIN-2024-SILVER",
    vendor: "Downies",
    product_type: "coins",
    properties: [],
    ...overrides,
  };
}

const COIN_GID = "gid://shopify/Product/100";
const EMPTY_COLLECTIBLE_IDS = new Set<string>();

// ─── filterCoinLineItems ──────────────────────────────────────────────────────

describe("filterCoinLineItems", () => {
  it("keeps a coin item that matches collectibleProductIds (primary signal)", () => {
    const item = makeLineItem({ product_type: "unknown_type" }); // type won't match
    const collectibleIds = new Set([COIN_GID]);

    const result = filterCoinLineItems([item], collectibleIds);
    expect(result).toHaveLength(1);
    expect(result[0].product_id).toBe(100);
  });

  it("keeps a coin item whose product_type matches the numismatic list (fallback)", () => {
    const item = makeLineItem({ product_type: "medal" });
    // Empty collectibleIds — relies on product_type fallback
    const result = filterCoinLineItems([item], EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(1);
  });

  it("excludes an item whose product_type is an accessory type", () => {
    const item = makeLineItem({ product_type: "case", product_id: 999 });
    const result = filterCoinLineItems([item], EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(0);
  });

  it("excludes an item whose title contains an accessory keyword", () => {
    const item = makeLineItem({
      title: "Coin Cleaning Kit",
      product_type: "coins", // would pass type check, but title overrides
    });
    const result = filterCoinLineItems([item], EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(0);
  });

  it("excludes an item whose vendor contains an accessory keyword", () => {
    const item = makeLineItem({ vendor: "Shipping & Postage Co", product_type: "commemorative" });
    const result = filterCoinLineItems([item], EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(0);
  });

  it("excludes line items with null product_id (shipping/fee lines)", () => {
    const item = makeLineItem({ product_id: null, title: "Standard Shipping" });
    const result = filterCoinLineItems([item], EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(0);
  });

  it("handles a mixed order: keeps coins, excludes accessories", () => {
    const coin = makeLineItem({ product_id: 1, product_type: "coins" });
    const medal = makeLineItem({ product_id: 2, product_type: "medal" });
    const accessory = makeLineItem({ product_id: 3, product_type: "cleaning kit" });
    const shipping = makeLineItem({ product_id: null, title: "Postage" });

    const result = filterCoinLineItems([coin, medal, accessory, shipping], EMPTY_COLLECTIBLE_IDS);

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.product_id)).toEqual(expect.arrayContaining([1, 2]));
    expect(result.map((i) => i.product_id)).not.toContain(null);
    expect(result.map((i) => i.product_id)).not.toContain(3);
  });

  it("returns empty array when all items are accessories", () => {
    const items = [
      makeLineItem({ product_type: "album" }),
      makeLineItem({ title: "Coin Storage Box" }),
    ];
    const result = filterCoinLineItems(items, EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(0);
  });

  it("is case-insensitive for product_type matching", () => {
    const item = makeLineItem({ product_type: "COINS" });
    const result = filterCoinLineItems([item], EMPTY_COLLECTIBLE_IDS);
    expect(result).toHaveLength(1);
  });

  /**
   * Demonstrates what happens when the collectible product list is empty:
   * products with unusual product_type (not in hardcoded list) are silently excluded.
   * This is why the caller MUST always fetch metafields and pass the correct set.
   */
  it("silently drops a coin with unusual product_type when collectibleProductIds is empty", () => {
    const unusualCoin = makeLineItem({
      product_type: "limited_edition_release", // not in hardcoded list
      product_id: 777,
    });

    const withEmptyIds = filterCoinLineItems([unusualCoin], EMPTY_COLLECTIBLE_IDS);
    expect(withEmptyIds).toHaveLength(0); // dropped — demonstrates the pitfall

    const withCorrectIds = filterCoinLineItems([unusualCoin], new Set([`gid://shopify/Product/777`]));
    expect(withCorrectIds).toHaveLength(1); // kept — metafield signal catches it
  });
});

// ─── buildCollectibleProductIds ───────────────────────────────────────────────

describe("buildCollectibleProductIds", () => {
  it("builds a set containing only products with hasCollectibleData=true", () => {
    const metafieldData = [
      { productGid: "gid://shopify/Product/1", hasCollectibleData: true },
      { productGid: "gid://shopify/Product/2", hasCollectibleData: false },
      { productGid: "gid://shopify/Product/3", hasCollectibleData: true },
    ];

    const result = buildCollectibleProductIds(metafieldData);

    expect(result.size).toBe(2);
    expect(result.has("gid://shopify/Product/1")).toBe(true);
    expect(result.has("gid://shopify/Product/3")).toBe(true);
    expect(result.has("gid://shopify/Product/2")).toBe(false);
  });

  it("returns an empty set when all products have no collectible_data metafield", () => {
    const metafieldData = [
      { productGid: "gid://shopify/Product/1", hasCollectibleData: false },
    ];
    const result = buildCollectibleProductIds(metafieldData);
    expect(result.size).toBe(0);
  });

  it("returns an empty set for empty input", () => {
    const result = buildCollectibleProductIds([]);
    expect(result.size).toBe(0);
  });
});
