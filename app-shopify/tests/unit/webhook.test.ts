/**
 * tests/unit/webhook.test.ts
 *
 * Covers the shared Shopify webhook authentication boundary before route processing.
 */

import { createHmac } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import { ErrorCode } from "~/types";

const TEST_SECRET = "webhook_test_secret";

function createWebhookRequest(
  body: string,
  options: { shop?: string; topic?: string; signatureBody?: string } = {}
): Request {
  const signature = createHmac("sha256", TEST_SECRET)
    .update(options.signatureBody ?? body)
    .digest("base64");

  return new Request("https://app.example.com/api/webhooks/orders-paid", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-shop-domain": options.shop ?? "test-shop.myshopify.com",
      "x-shopify-topic": options.topic ?? "orders/paid",
    },
    body,
  });
}

beforeEach(() => {
  process.env.SHOPIFY_APP_SECRET = TEST_SECRET;
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
});

describe("authenticateWebhookRequest", () => {
  it("returns a valid payload after authenticating body, shop, and topic", async () => {
    const body = JSON.stringify({ id: 123, customer: { id: 456 } });

    await expect(
      authenticateWebhookRequest<{ id: number }>(
        createWebhookRequest(body),
        "orders/paid"
      )
    ).resolves.toEqual({ id: 123, customer: { id: 456 } });
  });

  it("rejects a body changed after Shopify generated the HMAC", async () => {
    const original = JSON.stringify({ id: 123 });
    const tampered = JSON.stringify({ id: 999 });

    await expect(
      authenticateWebhookRequest(
        createWebhookRequest(tampered, { signatureBody: original }),
        "orders/paid"
      )
    ).rejects.toMatchObject({ code: ErrorCode.HMAC_INVALID });
  });

  it("rejects a valid signature delivered for a different shop", async () => {
    const body = JSON.stringify({ id: 123 });

    await expect(
      authenticateWebhookRequest(
        createWebhookRequest(body, { shop: "other-shop.myshopify.com" }),
        "orders/paid"
      )
    ).rejects.toMatchObject({ code: ErrorCode.HMAC_INVALID });
  });

  it("rejects a valid delivery routed to the wrong topic handler", async () => {
    const body = JSON.stringify({ id: 123 });

    await expect(
      authenticateWebhookRequest(
        createWebhookRequest(body, { topic: "orders/cancelled" }),
        "orders/paid"
      )
    ).rejects.toMatchObject({ code: ErrorCode.HMAC_INVALID });
  });

  it("rejects malformed signed JSON with the payload error code", async () => {
    await expect(
      authenticateWebhookRequest(createWebhookRequest("{"), "orders/paid")
    ).rejects.toMatchObject({ code: ErrorCode.WEBHOOK_INVALID_PAYLOAD });
  });

  it("rejects a signed JSON array instead of accepting it as a payload object", async () => {
    await expect(
      authenticateWebhookRequest(createWebhookRequest("[]"), "orders/paid")
    ).rejects.toMatchObject({ code: ErrorCode.WEBHOOK_INVALID_PAYLOAD });
  });
});
