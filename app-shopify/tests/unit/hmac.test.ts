/**
 * tests/unit/hmac.test.ts
 *
 * 100% coverage for hmac.server.ts (both App Proxy and Webhook modes).
 * This module must always have complete test coverage for security reasons.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { verifyAppProxyHmac, verifyWebhookHmac } from "~/lib/hmac.server";
import { ErrorCode } from "~/types";

const TEST_SECRET = "test_app_secret_abc123";

// Inject test secret before each test
beforeEach(() => {
  process.env.SHOPIFY_APP_SECRET = TEST_SECRET;
});

// ─── App Proxy HMAC ───────────────────────────────────────────────────────────

describe("verifyAppProxyHmac", () => {
  function buildValidParams(overrides: Record<string, string> = {}): URLSearchParams {
    const params: Record<string, string> = {
      shop: "test-shop.myshopify.com",
      path_prefix: "/apps/my-collection",
      logged_in_customer_id: "12345",
      timestamp: "1700000000",
      ...overrides,
    };

    // Shopify concatenates sorted key=value entries without ampersand separators.
    const message = Object.keys(params)
      .filter((k) => k !== "signature")
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("");

    params["signature"] = createHmac("sha256", TEST_SECRET).update(message).digest("hex");
    return new URLSearchParams(params);
  }

  it("passes verification when HMAC is correct", () => {
    const params = buildValidParams();
    expect(() => verifyAppProxyHmac(params)).not.toThrow();
  });

  it("throws HMAC_INVALID when signature is missing", () => {
    const params = buildValidParams();
    params.delete("signature");

    expect(() => verifyAppProxyHmac(params)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("throws HMAC_INVALID when signature is tampered", () => {
    const params = buildValidParams();
    params.set("signature", "a".repeat(64)); // wrong hex

    expect(() => verifyAppProxyHmac(params)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("throws HMAC_INVALID when a query param value is modified after signing", () => {
    const params = buildValidParams();
    params.set("logged_in_customer_id", "99999"); // tampered param

    expect(() => verifyAppProxyHmac(params)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("is not sensitive to param ordering — sorts params before comparing", () => {
    // Build params in reverse alphabetical order to verify sorting is applied
    const base = buildValidParams();
    const reordered = new URLSearchParams([...base.entries()].reverse());
    expect(() => verifyAppProxyHmac(reordered)).not.toThrow();
  });

  it("throws HMAC_INVALID when signed with a wrong secret", () => {
    const params = new URLSearchParams({
      shop: "test.myshopify.com",
      timestamp: "1700000000",
    });
    const message = [...params.entries()].sort().map(([key, value]) => `${key}=${value}`).join("");
    // Sign with a DIFFERENT secret than what's in the env
    params.set("signature", createHmac("sha256", "wrong_secret").update(message).digest("hex"));

    expect(() => verifyAppProxyHmac(params)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("uses Shopify's duplicate-value normalization and separator-free message", () => {
    const params = new URLSearchParams(
      "extra=1&extra=2&shop=test.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fmy-collection&timestamp=1700000000"
    );
    const message = "extra=1,2logged_in_customer_id=1path_prefix=/apps/my-collectionshop=test.myshopify.comtimestamp=1700000000";
    params.set("signature", createHmac("sha256", TEST_SECRET).update(message).digest("hex"));

    expect(() => verifyAppProxyHmac(params)).not.toThrow();
  });

});

// ─── Webhook HMAC ─────────────────────────────────────────────────────────────

describe("verifyWebhookHmac", () => {
  const testPayload = Buffer.from(JSON.stringify({ id: 1001, customer: { id: 42 } }));

  function buildValidHmacHeader(body: Buffer): string {
    return createHmac("sha256", TEST_SECRET).update(body).digest("base64");
  }

  it("passes verification when HMAC header is correct", () => {
    const header = buildValidHmacHeader(testPayload);
    expect(() => verifyWebhookHmac(testPayload, header)).not.toThrow();
  });

  it("throws HMAC_INVALID when header is null", () => {
    expect(() => verifyWebhookHmac(testPayload, null)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("throws HMAC_INVALID when header is tampered", () => {
    const tamperedHeader = buildValidHmacHeader(testPayload).slice(0, -4) + "XXXX";
    expect(() => verifyWebhookHmac(testPayload, tamperedHeader)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("throws HMAC_INVALID when body content is modified", () => {
    const validHeader = buildValidHmacHeader(testPayload);
    const modifiedBody = Buffer.from(JSON.stringify({ id: 9999 })); // different body

    expect(() => verifyWebhookHmac(modifiedBody, validHeader)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("throws HMAC_INVALID when signed with a wrong secret", () => {
    // Simulate a forged webhook signed with attacker's key
    const forgedHeader = createHmac("sha256", "attacker_key").update(testPayload).digest("base64");

    expect(() => verifyWebhookHmac(testPayload, forgedHeader)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });

  it("is sensitive to raw byte content — whitespace differences break signature", () => {
    // Shopify signs the exact bytes received; re-serialized JSON may differ
    const originalPayload = Buffer.from('{"id":1001}');
    const reformattedPayload = Buffer.from('{"id": 1001}'); // extra space

    const headerForOriginal = buildValidHmacHeader(originalPayload);

    // Header valid for original is NOT valid for reformatted
    expect(() => verifyWebhookHmac(reformattedPayload, headerForOriginal)).toThrow(
      expect.objectContaining({ code: ErrorCode.HMAC_INVALID })
    );
  });
});
