/** Bounded GraphQL alias tests for collectible product lookups. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import {
  COLLECTIBLE_LOOKUP_BATCH_SIZE,
  COLLECTIBLE_LOOKUP_CONCURRENCY,
} from "~/config/constants";

vi.mock("~/lib/graphql-client.server", () => ({ shopifyGraphQL: vi.fn() }));

const mockGraphQL = vi.mocked(shopifyGraphQL);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkProductsHaveCollectibleData", () => {
  it("bounds alias count and reaches exactly five concurrent lookup queries", async () => {
    const productCount = COLLECTIBLE_LOOKUP_BATCH_SIZE * COLLECTIBLE_LOOKUP_CONCURRENCY + 1;
    const productGids = Array.from(
      { length: productCount },
      (_, index) => `gid://shopify/Product/${index + 1}`
    );
    let activeQueries = 0;
    let maximumQueries = 0;
    let releaseFirstWave: (() => void) | undefined;
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    mockGraphQL.mockImplementation(async (_query, variables) => {
      activeQueries += 1;
      maximumQueries = Math.max(maximumQueries, activeQueries);
      if (maximumQueries <= COLLECTIBLE_LOOKUP_CONCURRENCY) await firstWaveGate;
      activeQueries -= 1;
      const ids = Object.values(variables ?? {}) as string[];
      return {
        data: Object.fromEntries(ids.map((gid) => [
          `prod_${gid.split("/").at(-1)}`,
          { m1: { value: "1900" } },
        ])),
      };
    });

    const lookup = checkProductsHaveCollectibleData(productGids);
    await vi.waitFor(() => expect(maximumQueries).toBe(COLLECTIBLE_LOOKUP_CONCURRENCY));
    releaseFirstWave?.();
    const result = await lookup;

    expect(result).toHaveLength(productCount);
    expect(result.every((item) => item.hasCollectibleData)).toBe(true);
    expect(mockGraphQL).toHaveBeenCalledTimes(COLLECTIBLE_LOOKUP_CONCURRENCY + 1);
    for (const [query] of mockGraphQL.mock.calls) {
      expect((String(query).match(/: product\(/g) ?? []).length).toBeLessThanOrEqual(
        COLLECTIBLE_LOOKUP_BATCH_SIZE
      );
    }
  });

  it("rejects the whole prerequisite when any lookup chunk fails", async () => {
    const productGids = Array.from(
      { length: COLLECTIBLE_LOOKUP_BATCH_SIZE + 1 },
      (_, index) => `gid://shopify/Product/${index + 1}`
    );
    mockGraphQL
      .mockRejectedValueOnce(new Error("temporary lookup failure"))
      .mockResolvedValueOnce({ data: { prod_26: null } });

    await expect(checkProductsHaveCollectibleData(productGids)).rejects.toThrow(
      "temporary lookup failure"
    );
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
  });
});
