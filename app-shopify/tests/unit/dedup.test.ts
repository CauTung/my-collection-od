/**
 * tests/unit/dedup.test.ts
 *
 * Tests for the atomic order deduplication engine.
 *
 * All Shopify Admin GraphQL calls are mocked — this is unit-level testing.
 * MUST VERIFY ON DEV STORE: The actual metaobjectCreate call against
 * a real Shopify store must be verified before going to production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { claimOrderSync } from "~/lib/dedup.server";

// Mock the GraphQL client — dedup.server.ts uses shopifyGraphQL internally
vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn(),
  isDuplicateHandleError: vi.fn((userErrors: Array<{ message: string }>) => {
    return userErrors.some((e) => e.message.toLowerCase().includes("taken") || e.message.toLowerCase().includes("already"));
  }),
}));

import { shopifyGraphQL } from "~/lib/graphql-client.server";

const mockGraphQL = vi.mocked(shopifyGraphQL);

const CUSTOMER_GID = "gid://shopify/Customer/12345";
const ORDER_GID = "gid://shopify/Order/67890";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimOrderSync", () => {
  it("returns true when metaobjectCreate succeeds (first-time claim)", async () => {
    mockGraphQL.mockResolvedValue({
      data: {
        metaobjectCreate: {
          metaobject: { id: "gid://shopify/Metaobject/abc" },
          userErrors: [],
        },
      },
    });

    const result = await claimOrderSync(CUSTOMER_GID, ORDER_GID);
    expect(result).toBe(true);
  });

  it("returns false when userErrors contains 'taken' (duplicate claim)", async () => {
    mockGraphQL.mockResolvedValue({
      data: {
        metaobjectCreate: {
          metaobject: null,
          userErrors: [{ message: "Handle has already been taken", field: ["handle"] }],
        },
      },
    });

    const result = await claimOrderSync(CUSTOMER_GID, ORDER_GID);
    expect(result).toBe(false);
  });

  it("returns false when userErrors contains 'already' (alternative duplicate message)", async () => {
    mockGraphQL.mockResolvedValue({
      data: {
        metaobjectCreate: {
          metaobject: null,
          userErrors: [{ message: "already exists", field: ["handle"] }],
        },
      },
    });

    const result = await claimOrderSync(CUSTOMER_GID, ORDER_GID);
    expect(result).toBe(false);
  });

  it("throws on unexpected userErrors — so the webhook can retry or batch-sync can record a failure", async () => {
    mockGraphQL.mockResolvedValue({
      data: {
        metaobjectCreate: {
          metaobject: null,
          userErrors: [{ message: "Permission denied on field 'customer_id'", field: ["customer_id"] }],
        },
      },
    });

    await expect(claimOrderSync(CUSTOMER_GID, ORDER_GID)).rejects.toThrow("Unexpected error during dedup claim");
  });

  it("uses the correct normalized handle format dedup-{customerId}-{orderId}", async () => {
    mockGraphQL.mockResolvedValue({
      data: {
        metaobjectCreate: {
          metaobject: { id: "gid://shopify/Metaobject/xyz" },
          userErrors: [],
        },
      },
    });

    await claimOrderSync(CUSTOMER_GID, ORDER_GID);

    // Verify the handle passed to GraphQL uses numeric IDs extracted from GIDs
    const callArgs = mockGraphQL.mock.calls[0];
    expect(callArgs?.[0]).toContain("ClaimOrderSync");
    const variables = callArgs?.[1] as { input: { handle: string; type: string } };
    expect(variables.input.handle).toBe("dedup-12345-67890");
  });

  it("uses the correct type for the dedup lock metaobject", async () => {
    mockGraphQL.mockResolvedValue({
      data: {
        metaobjectCreate: {
          metaobject: { id: "gid://shopify/Metaobject/xyz" },
          userErrors: [],
        },
      },
    });

    await claimOrderSync(CUSTOMER_GID, ORDER_GID);

    const callArgs = mockGraphQL.mock.calls[0];
    const variables = callArgs?.[1] as { input: { type: string } };
    expect(variables.input.type).toBe("collection_dedup_lock");
  });

  it("simulates two concurrent claims — second must return false", async () => {
    // First call: success
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectCreate: {
          metaobject: { id: "gid://shopify/Metaobject/abc" },
          userErrors: [],
        },
      },
    });

    // Second call: duplicate handle collision (simulating Shopify's uniqueness enforcement)
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectCreate: {
          metaobject: null,
          userErrors: [{ message: "Handle has already been taken", field: ["handle"] }],
        },
      },
    });

    const [first, second] = await Promise.all([
      claimOrderSync(CUSTOMER_GID, ORDER_GID),
      claimOrderSync(CUSTOMER_GID, ORDER_GID),
    ]);

    // Exactly one must succeed, one must fail — atomic dedup guarantee
    const successCount = [first, second].filter(Boolean).length;
    const failCount = [first, second].filter((r) => !r).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });
});
