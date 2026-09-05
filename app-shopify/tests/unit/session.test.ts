/**
 * tests/unit/session.test.ts
 *
 * Verifies that customer identity is returned only after authenticating the complete
 * Shopify App Proxy query string.
 */

import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateAppProxyRequest } from "~/lib/session.server";
import { ErrorCode } from "~/types";

const TEST_SECRET = "session_test_secret";
const TEST_TIMESTAMP_SECONDS = 1_700_000_000;

function createSignedRequest(overrides: Record<string, string> = {}): Request {
  const parameters: Record<string, string> = {
    logged_in_customer_id: "12345",
    path_prefix: "/apps/my-collection",
    shop: "test-shop.myshopify.com",
    timestamp: String(TEST_TIMESTAMP_SECONDS),
    ...overrides,
  };
  const message = Object.entries(parameters)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  const signature = createHmac("sha256", TEST_SECRET).update(message).digest("hex");
  const query = new URLSearchParams({ ...parameters, signature });

  return new Request(`https://app.example.com/api/collection?${query.toString()}`);
}

beforeEach(() => {
  process.env.SHOPIFY_APP_SECRET = TEST_SECRET;
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
  vi.useFakeTimers();
  vi.setSystemTime(TEST_TIMESTAMP_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("authenticateAppProxyRequest", () => {
  it("returns a normalized customer context from a valid signed request", () => {
    const context = authenticateAppProxyRequest(createSignedRequest());

    expect(context).toEqual({
      customer_id: "gid://shopify/Customer/12345",
      path_prefix: "/apps/my-collection",
      shop: "test-shop.myshopify.com",
    });
  });

  it("rejects a direct unsigned backend request before trusting the customer ID", () => {
    const request = new Request(
      "https://app.example.com/api/collection?logged_in_customer_id=99999"
    );

    expect(() => authenticateAppProxyRequest(request)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("rejects a customer ID changed after Shopify signed the request", () => {
    const signedRequest = createSignedRequest();
    const tamperedUrl = new URL(signedRequest.url);
    tamperedUrl.searchParams.set("logged_in_customer_id", "99999");

    expect(() => authenticateAppProxyRequest(new Request(tamperedUrl))).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("rejects a valid Shopify signature issued for a different shop", () => {
    const request = createSignedRequest({ shop: "other-shop.myshopify.com" });

    expect(() => authenticateAppProxyRequest(request)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("rejects an anonymous customer after validating the Shopify signature", () => {
    expect(() =>
      authenticateAppProxyRequest(createSignedRequest({ logged_in_customer_id: "" }))
    ).toThrow(expect.objectContaining({ code: ErrorCode.CUSTOMER_NOT_AUTHENTICATED }));
  });
});
