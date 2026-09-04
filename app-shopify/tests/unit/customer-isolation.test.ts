/**
 * tests/unit/customer-isolation.test.ts
 *
 * MANDATORY TEST: Verification of Customer Data Isolation.
 * Ensures that fetching items for Customer A never leaks items belonging to Customer B.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCollectionItems } from "~/lib/metaobject.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";

vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn(),
}));

const mockGraphQL = vi.mocked(shopifyGraphQL);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Customer Data Isolation", () => {
  it("must include exact customer_id in the GraphQL query filter to prevent data leakage", async () => {
    const customerA = "gid://shopify/Customer/111";
    
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
      },
    });

    await listCollectionItems(customerA, {});

    // Verify the query string actually contains the isolation filter
    const graphqlCalls = mockGraphQL.mock.calls;
    expect(graphqlCalls.length).toBe(1);
    
    const query = graphqlCalls[0][0];
    
    // The query MUST contain a hard filter against the specific customer_id
    expect(query).toContain("query: $query");
    
    const variables = graphqlCalls[0][1] as { query: string };
    expect(variables.query).toContain(customerA);
    expect(variables.query).toContain("customer_id");
  });

  it("must retain customer_id in the returned mapped objects for application-level defense-in-depth", async () => {
    const customerA = "gid://shopify/Customer/111";
    const customerB = "gid://shopify/Customer/222";
    
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [
            {
              id: "gid://shopify/Metaobject/1",
              handle: "item-1",
              fields: [
                { key: "item_id", value: "uuid-1" },
                { key: "customer_id", value: customerA }, // Item belongs to A
                { key: "product_id", value: "gid://shopify/Product/999" },
                { key: "quantity_owned", value: "1" },
              ]
            },
            {
              id: "gid://shopify/Metaobject/2",
              handle: "item-2",
              fields: [
                { key: "item_id", value: "uuid-2" },
                { key: "customer_id", value: customerB }, // Item belongs to B
                { key: "product_id", value: "gid://shopify/Product/888" },
                { key: "quantity_owned", value: "1" },
              ]
            }
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    });

    const result = await listCollectionItems(customerA, {});
    
    // Application-layer isolation: even if Shopify returned B's item due to a query bug,
    // the application must filter it out.
    expect(result.items).toHaveLength(1);
    
    // Defense-in-depth: the mapper MUST NOT strip customer_id. 
    // This allows UI or subsequent business logic to double-check ownership if needed.
    expect(result.items[0].customer_id).toBe(customerA);
  });
});
