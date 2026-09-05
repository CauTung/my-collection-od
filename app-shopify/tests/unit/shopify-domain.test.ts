import { describe, expect, it } from "vitest";

import { normalizeShopifyShopDomain } from "~/lib/shopify-domain.server";

describe("normalizeShopifyShopDomain", () => {
  it("returns a hostname unchanged when the environment value is already a hostname", () => {
    expect(normalizeShopifyShopDomain("my-collection-od.myshopify.com")).toBe(
      "my-collection-od.myshopify.com"
    );
  });

  it("strips an HTTPS protocol and trailing slash pasted into an environment variable", () => {
    expect(
      normalizeShopifyShopDomain(" https://MY-COLLECTION-OD.myshopify.com/ ")
    ).toBe("my-collection-od.myshopify.com");
  });

  it("rejects a value containing an Admin API path", () => {
    expect(() =>
      normalizeShopifyShopDomain(
        "https://my-collection-od.myshopify.com/admin/api/2024-10/graphql.json"
      )
    ).toThrow("do not include an API path or query string");
  });

  it("rejects a non-Shopify hostname", () => {
    expect(() => normalizeShopifyShopDomain("https://example.com")).toThrow(
      "SHOPIFY_SHOP_DOMAIN must be a Shopify hostname"
    );
  });
});
