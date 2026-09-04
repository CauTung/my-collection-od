/**
 * tests/unit/stats.test.ts
 *
 * Unit tests for the stats calculation and caching module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { updateCustomerStatsMetafields } from "~/lib/metafield.server";

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
                { key: "quantity_owned", value: "2" },
                { key: "current_market_value", value: "50.00" }, // 2 * 50 = 100
              ],
            },
            {
              fields: [
                { key: "quantity_owned", value: "1" },
                { key: "purchase_price", value: "25.50" }, // 1 * 25.5 = 25.5 (fallback to purchase price)
              ],
            },
            {
              fields: [
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
