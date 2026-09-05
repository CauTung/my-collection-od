/** Ensures every Shopify webhook route rejects unauthenticated direct requests. */

import { beforeEach, describe, expect, it } from "vitest";
import { action as ordersPaidAction } from "~/routes/api.webhooks.orders-paid";
import { action as ordersCancelledAction } from "~/routes/api.webhooks.orders-cancelled";
import { action as refundsCreateAction } from "~/routes/api.webhooks.refunds-create";
import { action as customerDataRequestAction } from "~/routes/api.webhooks.customers-data-request";
import { action as customerRedactAction } from "~/routes/api.webhooks.customers-redact";
import { action as shopRedactAction } from "~/routes/api.webhooks.shop-redact";

type WebhookAction = typeof ordersPaidAction;

function invokeUnsigned(action: WebhookAction, path: string): Promise<Response> {
  return action({
    request: new Request(`https://app.example.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 123 }),
    }),
  } as Parameters<WebhookAction>[0]);
}

beforeEach(() => {
  process.env.SHOPIFY_APP_SECRET = "webhook_route_secret";
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
});

describe("Shopify webhook route authentication", () => {
  it("returns exact 401 HMAC_INVALID responses for all webhook routes", async () => {
    const results = await Promise.all([
      invokeUnsigned(ordersPaidAction, "/api/webhooks/orders-paid"),
      invokeUnsigned(ordersCancelledAction, "/api/webhooks/orders-cancelled"),
      invokeUnsigned(refundsCreateAction, "/api/webhooks/refunds-create"),
      invokeUnsigned(customerDataRequestAction, "/api/webhooks/customers-data-request"),
      invokeUnsigned(customerRedactAction, "/api/webhooks/customers-redact"),
      invokeUnsigned(shopRedactAction, "/api/webhooks/shop-redact"),
    ]);

    expect(results).toHaveLength(6);
    for (const response of results) {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: "HMAC_INVALID" });
    }
  });
});
