/**
 * app/routes/api.webhooks.customers-redact.ts
 *
 * Webhook handler for customers/redact (GDPR).
 * Deletes all collection items and stats for the redacted customer.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import {
  hardDeleteCollectionMetaobject,
  listCollectionMetaobjectsForPrivacyDeletion,
} from "~/lib/metaobject.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { logger } from "~/lib/logger.server";

interface CustomerRedactPayload {
  customer?: { id?: number | string };
}

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const payload = await authenticateWebhookRequest<CustomerRedactPayload>(
    request,
    "customers/redact"
  );
  const customerIdRaw = payload.customer?.id;
  if (!customerIdRaw) {
    return new Response("OK", { status: 200 }); // Nothing to redact
  }

  const customerId = `gid://shopify/Customer/${customerIdRaw}`;
  logger.info("Processing customers/redact", { customerId });

  // Re-read the first page after each hard-delete batch. Reusing cursors while deleting
  // the underlying connection can skip records as the result set shrinks.
  while (true) {
    const items = await listCollectionMetaobjectsForPrivacyDeletion(customerId);
    if (items.length === 0) {
      break;
    }
    const deletions = await Promise.allSettled(
      items.map((item) => hardDeleteCollectionMetaobject(customerId, item.id))
    );
    const failures = deletions.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw failures[0].reason;
    }
  }

  // Acknowledge receipt to Shopify
  return new Response("OK", { status: 200 });
}

export const action = withErrorHandler(actionHandler);
