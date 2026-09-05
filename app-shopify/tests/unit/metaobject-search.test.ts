/** Shopify Metaobject search-contract and escaping tests. */

import { describe, expect, it } from "vitest";
import { buildMetaobjectFieldFilter } from "~/lib/metaobject-search.server";

describe("buildMetaobjectFieldFilter", () => {
  it("uses the exact Shopify field-filter syntax", () => {
    expect(buildMetaobjectFieldFilter("customer_id", "gid://shopify/Customer/123")).toBe(
      'fields.customer_id:"gid://shopify/Customer/123"'
    );
  });

  it("escapes quotes and backslashes in filter values", () => {
    expect(buildMetaobjectFieldFilter("customer_id", 'value"\\tail')).toBe(
      'fields.customer_id:"value\\"\\\\tail"'
    );
  });

  it("rejects a field key that could alter the expression", () => {
    expect(() => buildMetaobjectFieldFilter("customer_id:foo", "value")).toThrow(
      "Invalid metaobject field key"
    );
  });
});
