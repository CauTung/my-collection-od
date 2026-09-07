/**
 * tests/unit/stats.test.ts
 *
 * Unit tests for the stats calculation and caching module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { updateCustomerStatsMetafields, getCustomerCollectionMetafields } from "~/lib/metafield.server";

vi.mock("~/lib/integrations/yotpo.server", () => ({ awardLoyaltyPoints: vi.fn().mockResolvedValue(undefined) }));
vi.mock("~/lib/integrations/klaviyo.server", () => ({ syncCustomerToKlaviyo: vi.fn().mockResolvedValue(undefined) }));

vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn(),
}));

vi.mock("~/lib/metafield.server", () => ({
  updateCustomerStatsMetafields: vi.fn(),
  getCustomerCollectionMetafields: vi.fn().mockResolvedValue({ stats: { total_items: 0, total_value: 0 } }),
}));

const mockGraphQL = vi.mocked(shopifyGraphQL);
const mockUpdateMetafields = vi.mocked(updateCustomerStatsMetafields);

const CUSTOMER_GID = "gid://shopify/Customer/123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recalculateAndCacheStats", () => {
  it("calculates stats correctly for a single page of items", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [
            {
              fields: [
                { key: "customer_id", value: CUSTOMER_GID },
                { key: "is_deleted", value: "false" },
                { key: "quantity_owned", value: "2" },
                { key: "current_market_value", value: "50.00" }, // 2 * 50 = 100
              ],
            },
            {
              fields: [
                { key: "customer_id", value: CUSTOMER_GID },
                { key: "is_deleted", value: "false" },
                { key: "quantity_owned", value: "1" },
                { key: "purchase_price", value: "25.50" }, // 1 * 25.5 = 25.5 (fallback to purchase price)
              ],
            },
            {
              fields: [
                { key: "customer_id", value: CUSTOMER_GID },
                { key: "is_deleted", value: "false" },
                { key: "quantity_owned", value: "3" }, // No value fields -> 3 * 0 = 0
              ],
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    });

    const stats = await recalculateAndCacheStats(CUSTOMER_GID);

    // Items: 2 + 1 + 3 = 6
    // Value: 100 + 25.5 + 0 = 125.5
    expect(stats.total_items).toBe(6);
    expect(stats.total_value).toBe(125.5);

    expect(mockUpdateMetafields).toHaveBeenCalledWith(CUSTOMER_GID, {
      total_items: 6,
      total_value: 125.5,
    });
  });

  it("handles pagination correctly", async () => {
    // Page 1
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [
            {
              fields: [
                { key: "customer_id", value: CUSTOMER_GID },
                { key: "is_deleted", value: "false" },
                { key: "quantity_owned", value: "1" },
                { key: "current_market_value", value: "10" },
              ],
            },
          ],
          pageInfo: {
            hasNextPage: true,
            endCursor: "cursor1",
          },
        },
      },
    });

    // Page 2
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [
            {
              fields: [
                { key: "customer_id", value: CUSTOMER_GID },
                { key: "is_deleted", value: "false" },
                { key: "quantity_owned", value: "2" },
                { key: "current_market_value", value: "20" },
              ],
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    });

    const stats = await recalculateAndCacheStats(CUSTOMER_GID);

    // Items: 1 + 2 = 3
    // Value: 10 + 40 = 50
    expect(stats.total_items).toBe(3);
    expect(stats.total_value).toBe(50);
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
  });

  it("returns 0 if customer has no items", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    const stats = await recalculateAndCacheStats(CUSTOMER_GID);

    expect(stats.total_items).toBe(0);
    expect(stats.total_value).toBe(0);
  });
});

function page(fields: Record<string, string>, hasNextPage = false, endCursor: string | null = null) {
  return { data: { metaobjects: { nodes: [{ fields: Object.entries(fields).map(([key, value]) => ({ key, value })) }], pageInfo: { hasNextPage, endCursor } } } };
}
const validFields = { customer_id: CUSTOMER_GID, is_deleted: "false", quantity_owned: "2", purchase_price: "10.25" };

describe("stats integrity failures", () => {
  it.each([
    { customer_id: "gid://shopify/Customer/456" }, { is_deleted: "true" },
    { quantity_owned: "2junk" }, { quantity_owned: "1.5" }, { quantity_owned: "0" },
    { purchase_price: "NaN" }, { purchase_price: "-1" }, { purchase_price: "12junk" },
    { current_market_value: "" }, { quantity_owned: "9007199254740992" },
  ])("rejects invalid collection fields without updating the cache: %j", async (override) => {
    mockGraphQL.mockResolvedValueOnce(page({ ...validFields, ...override }));
    await expect(recalculateAndCacheStats(CUSTOMER_GID)).rejects.toThrow();
    expect(mockUpdateMetafields).toHaveBeenCalledTimes(0);
  });
  it("does not cache either customer's totals when a later page contains another owner's item", async () => {
    mockGraphQL.mockResolvedValueOnce(page(validFields, true, "first"));
    mockGraphQL.mockResolvedValueOnce(page({ ...validFields, customer_id: "gid://shopify/Customer/456", quantity_owned: "7" }));
    await expect(recalculateAndCacheStats(CUSTOMER_GID)).rejects.toThrow("ownership");
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
    expect(mockUpdateMetafields).toHaveBeenCalledTimes(0);
  });
  it.each([{ data: {} }, { data: { metaobjects: { nodes: [] } } }, { data: { metaobjects: { pageInfo: { hasNextPage: false, endCursor: null } } } }])("rejects malformed pages without replacing existing cache with zero", async (response) => {
    mockGraphQL.mockResolvedValueOnce(response);
    await expect(recalculateAndCacheStats(CUSTOMER_GID)).rejects.toThrow("valid collection page");
    expect(mockUpdateMetafields).toHaveBeenCalledTimes(0);
  });
  it("rejects repeated pagination cursors without writing partial totals", async () => {
    mockGraphQL.mockResolvedValueOnce(page(validFields, true, "repeat"));
    mockGraphQL.mockResolvedValueOnce(page(validFields, true, "repeat"));
    await expect(recalculateAndCacheStats(CUSTOMER_GID)).rejects.toThrow("did not advance");
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
    expect(mockUpdateMetafields).toHaveBeenCalledTimes(0);
  });
  it("propagates a failed old-cache read instead of inferring first-time eligibility", async () => {
    vi.mocked(getCustomerCollectionMetafields).mockRejectedValueOnce(new Error("cache unavailable"));
    await expect(recalculateAndCacheStats(CUSTOMER_GID)).rejects.toThrow("cache unavailable");
    expect(mockGraphQL).toHaveBeenCalledTimes(0);
    expect(mockUpdateMetafields).toHaveBeenCalledTimes(0);
  });
});
