/** Unit coverage for minimal order context used by refund webhooks. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrderCustomerId } from "~/lib/order.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { ErrorCode } from "~/types";

vi.mock("~/lib/graphql-client.server", () => ({ shopifyGraphQL: vi.fn() }));

const mockGraphQL = vi.mocked(shopifyGraphQL);
const ORDER_ID = "gid://shopify/Order/123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrderCustomerId", () => {
  it("returns the order customer using a named query and variables", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: { order: { customer: { id: "gid://shopify/Customer/456" } } },
    });

    await expect(getOrderCustomerId(ORDER_ID)).resolves.toBe(
      "gid://shopify/Customer/456"
    );
    expect(mockGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("query GetWebhookOrderCustomer"),
      { id: ORDER_ID }
    );
  });

  it("returns null for a guest or deleted-customer order", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { order: { customer: null } } });

    await expect(getOrderCustomerId(ORDER_ID)).resolves.toBeNull();
  });

  it("rejects a response that omits the expected order payload", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: {} });

    await expect(getOrderCustomerId(ORDER_ID)).rejects.toMatchObject({
      code: ErrorCode.GRAPHQL_ERROR,
    });
  });

  it("rejects an inaccessible order instead of treating it as a guest order", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: { order: null } });

    await expect(getOrderCustomerId(ORDER_ID)).rejects.toMatchObject({
      code: ErrorCode.GRAPHQL_ERROR,
    });
  });
});
