/** URL and authentication contract for the centralized Admin GraphQL client. */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("shopifyGraphQL", () => {
  it("calls the configured shop through the exact shared Admin API version", async () => {
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "test-shop.myshopify.com");
    vi.stubEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", "test-admin-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: { shop: { id: "gid://shopify/Shop/1" } } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { shopifyGraphQL } = await import("~/lib/graphql-client.server");
    await shopifyGraphQL("query GetShop { shop { id } }");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://test-shop.myshopify.com/admin/api/2026-07/graphql.json"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": "test-admin-token",
      },
    });
  });
});
