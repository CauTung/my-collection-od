/** Resilience, authentication, and rate-limit contract for the Admin GraphQL client. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRAPHQL_MAX_RETRY_ATTEMPTS,
  GRAPHQL_RETRY_BASE_DELAY_MS,
} from "~/config/constants";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { ErrorCode } from "~/types";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulResponse(): Response {
  return jsonResponse({ data: { shop: { id: "gid://shopify/Shop/1" } } });
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "test-shop.myshopify.com");
  vi.stubEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", "test-admin-token");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shopifyGraphQL", () => {
  it("calls the configured shop through the exact shared Admin API version", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(successfulResponse()));
    vi.stubGlobal("fetch", fetchMock);

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

  it("reads deployment configuration for each public request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(successfulResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await shopifyGraphQL("query GetFirstShop { shop { id } }");
    vi.stubEnv("SHOPIFY_SHOP_DOMAIN", "second-shop.myshopify.com");
    vi.stubEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", "second-token");
    await shopifyGraphQL("query GetSecondShop { shop { id } }");

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://second-shop.myshopify.com/admin/api/2026-07/graphql.json"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { "X-Shopify-Access-Token": "second-token" },
    });
  });

  it("retries HTTP 429 with exact exponential delays and then succeeds", async () => {
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(successfulResponse());
    vi.stubGlobal("fetch", fetchMock);

    const request = shopifyGraphQL("query GetShopAfter429 { shop { id } }");
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timerSpy.mock.calls.map((call) => call[1])).toEqual([
      GRAPHQL_RETRY_BASE_DELAY_MS,
      GRAPHQL_RETRY_BASE_DELAY_MS * 2,
    ]);
  });

  it("retries a THROTTLED GraphQL response and preserves the variables", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: null,
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      }))
      .mockResolvedValueOnce(successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    const variables = { id: "gid://shopify/Product/1" };

    const request = shopifyGraphQL("query GetProduct($id: ID!) { product(id: $id) { id } }", variables);
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?] | undefined;
    const secondBody = secondCall?.[1]?.body;
    expect(typeof secondBody).toBe("string");
    if (typeof secondBody !== "string") throw new Error("Expected a serialized GraphQL body");
    expect(JSON.parse(secondBody)).toEqual({
      query: "query GetProduct($id: ID!) { product(id: $id) { id } }",
      variables,
    });
  });

  it("stops after the configured number of 429 retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = shopifyGraphQL("query GetAlwaysThrottledShop { shop { id } }");
    const rejection = expect(request).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
    await vi.runAllTimersAsync();
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(GRAPHQL_MAX_RETRY_ATTEMPTS + 1);
  });

  it("does not retry a mutation after a network error with an unknown commit state", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(shopifyGraphQL("mutation UpdateItem { metafieldsSet(metafields: []) { userErrors { message } } }"))
      .rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for the exact reported bucket deficit after a successful alias response", async () => {
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      data: { first: { id: "1" }, second: { id: "2" } },
      extensions: {
        cost: {
          requestedQueryCost: 100,
          actualQueryCost: 100,
          throttleStatus: { maximumAvailable: 5000, currentlyAvailable: 50, restoreRate: 50 },
        },
      },
    })));

    const request = shopifyGraphQL("query GetAliasedProducts { first: product(id: \"1\") { id } second: product(id: \"2\") { id } }");
    await vi.runAllTimersAsync();
    await request;

    expect(timerSpy).toHaveBeenCalledTimes(1);
    expect(timerSpy.mock.calls[0]?.[1]).toBe(3000);
  });

  it("throws execution errors immediately without an unrelated proactive wait", async () => {
    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      data: null,
      errors: [{ message: "Access denied" }],
      extensions: {
        cost: {
          requestedQueryCost: 10,
          actualQueryCost: 10,
          throttleStatus: { maximumAvailable: 5000, currentlyAvailable: 0, restoreRate: 50 },
        },
      },
    })));

    await expect(shopifyGraphQL("query GetForbiddenShop { shop { id } }"))
      .rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
    expect(timerSpy).toHaveBeenCalledTimes(0);
  });

  it("converts an invalid JSON response into the standard GraphQL error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(shopifyGraphQL("query GetInvalidResponse { shop { id } }"))
      .rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
  });
});
