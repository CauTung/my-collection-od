/**
 * app/routes/api.webhooks.shop-redact.ts
 *
 * Webhook handler for shop/redact (GDPR).
 * Since we don't have an external database and all data is stored natively
 * in Shopify Metaobjects/Metafields, there is no external data to delete.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { logger } from "~/lib/logger.server";

interface ShopRedactPayload {
  shop_id?: number | string;
  shop_domain?: string;
}

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const payload = await authenticateWebhookRequest<ShopRedactPayload>(
    request,
    "shop/redact"
  );

  logger.info("Received shop/redact GDPR webhook. No external DB data to redact.", { 
    shop_domain: payload?.shop_domain, 
  });

  // Acknowledge receipt to Shopify
  return new Response("OK", { status: 200 });
}

export const action = withErrorHandler(actionHandler);
