/**
 * app/routes/api.webhooks.shop-redact.ts
 *
 * Webhook handler for shop/redact (GDPR).
 * Since we don't have an external database and all data is stored natively
 * in Shopify Metaobjects/Metafields, there is no external data to delete.
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
    logger.warn("Webhook HMAC verification failed (GDPR shop/redact)", { error: String(error) });
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    logger.error("Failed to parse GDPR webhook payload", { error: String(error) });
  }

  logger.info("Received shop/redact GDPR webhook. No external DB data to redact.", { 
    shop_domain: payload?.shop_domain, 
  });

  // Acknowledge receipt to Shopify
  return new Response("OK", { status: 200 });
}
