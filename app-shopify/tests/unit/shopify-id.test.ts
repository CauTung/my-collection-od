/** Shopify global ID normalization tests. */

import { describe, expect, it } from "vitest";
import { extractShopifyIdSegment, extractShopifyNumericId } from "~/lib/shopify-id.server";

describe("extractShopifyNumericId", () => {
  it("extracts the exact numeric resource identifier", () => {
    expect(extractShopifyNumericId("gid://shopify/Customer/12345")).toBe("12345");
  });

  it("preserves safe event suffixes used by dedup handles", () => {
    expect(extractShopifyIdSegment("gid://shopify/Order/67890-cancel")).toBe("67890-cancel");
    expect(extractShopifyIdSegment("refund-700")).toBe("refund-700");
  });

  it("rejects malformed and non-numeric identifiers", () => {
    expect(() => extractShopifyNumericId("gid://shopify/Customer/not-numeric")).toThrow(
      "Invalid Shopify numeric GID"
    );
    expect(() => extractShopifyNumericId("")).toThrow("Invalid Shopify numeric GID");
  });
});
