/**
 * app/routes/api.webhooks.customers-data-request.ts
 *
 * Webhook handler for customers/data_request (GDPR).
 * Returns 200 OK as required by Shopify.
 *
 * MVP: Log the request. In a full implementation, this might email the user
 * or generate a JSON dump of their collection data.
 */

import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookHmac } from "~/lib/hmac.server";
import { logger } from "~/lib/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const rawBody = Buffer.from(await request.arrayBuffer());

  try {
    verifyWebhookHmac(rawBody, hmacHeader);
  } catch (error) {
    logger.warn("Webhook HMAC verification failed (GDPR data_request)", { error: String(error) });
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const payload = JSON.parse(rawBody.toString("utf-8"));
    logger.info("Received customers/data_request GDPR webhook", {
      shop_domain: payload.shop_domain,
      customer_id: payload.customer?.id,
      customer_email: payload.customer?.email,
    });
  } catch (error) {
    logger.error("Failed to parse GDPR webhook payload", { error: String(error) });
  }

  // Acknowledge receipt to Shopify
  return new Response("OK", { status: 200 });
}
