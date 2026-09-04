/**
 * app/routes/api.webhooks.customers-redact.ts
 *
 * Webhook handler for customers/redact (GDPR).
 * Deletes all collection items and stats for the redacted customer.
 */

import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookHmac } from "~/lib/hmac.server";
import { listCollectionItems, deleteCollectionItem } from "~/lib/metaobject.server";
import { logger } from "~/lib/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const rawBody = Buffer.from(await request.arrayBuffer());
  
  try {
    verifyWebhookHmac(rawBody, hmacHeader);
  } catch (error) {
    logger.warn("Webhook HMAC verification failed (GDPR customers/redact)", { error: String(error) });
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    logger.error("Failed to parse GDPR webhook payload", { error: String(error) });
    return new Response("Bad Request", { status: 400 });
  }

  const customer = payload.customer as { id?: number | string } | undefined;
  const customerIdRaw = customer?.id;
  if (!customerIdRaw) {
    return new Response("OK", { status: 200 }); // Nothing to redact
  }

  const customerId = `gid://shopify/Customer/${customerIdRaw}`;
  logger.info("Processing customers/redact", { customerId });

  // Paginating through all customer items and soft-deleting them
  let hasNextPage = true;
  let cursor: string | undefined = undefined;

  try {
    while (hasNextPage) {
      const result = await listCollectionItems(customerId, {
        first: 250,
        after: cursor,
      });

      const promises = result.items.map((item) =>
        deleteCollectionItem(customerId, item.item_id).catch((err) => {
          logger.error("Failed to delete item during redact", { itemId: item.item_id, error: String(err) });
        })
      );
      
      await Promise.all(promises);

      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor || undefined;
    }
  } catch (error) {
    logger.error("Error during customers/redact processing", { customerId, error: String(error) });
  }

  // Acknowledge receipt to Shopify
  return new Response("OK", { status: 200 });
}
