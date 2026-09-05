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
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { logger } from "~/lib/logger.server";

interface CustomerDataRequestPayload {
  shop_domain?: string;
  customer?: { id?: number | string };
  data_request?: { id?: number | string };
  orders_requested?: Array<number | string>;
}

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const payload = await authenticateWebhookRequest<CustomerDataRequestPayload>(
    request,
    "customers/data_request"
  );
  logger.info("Received customers/data_request GDPR webhook", {
    dataRequestId: payload.data_request?.id,
    requestedOrderCount: payload.orders_requested?.length ?? 0,
    hasCustomerId: Boolean(payload.customer?.id),
  });

  // Acknowledge receipt to Shopify
  return new Response("OK", { status: 200 });
}

export const action = withErrorHandler(actionHandler);
