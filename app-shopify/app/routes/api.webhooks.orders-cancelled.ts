/**
 * app/routes/api.webhooks.orders-cancelled.ts
 *
 * Webhook handler for orders/cancelled.
 *
 * Design decisions:
 * - Uses HMAC verification.
 * - Extracts valid coins via filterCoinLineItems.
 * - Atomic dedup using claimOrderSync with a specific prefix for cancellation.
 * - Decrements quantity_owned by the cancelled amount. If quantity <= 0, soft deletes the item.
 * - Recalculates stats.
 */

import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookHmac } from "~/lib/hmac.server";
import { claimOrderSync } from "~/lib/dedup.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { findCollectionItemByProduct, updateCollectionItem, deleteCollectionItem } from "~/lib/metaobject.server";
import { filterCoinLineItems, buildCollectibleProductIds } from "~/lib/product-filter.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { logger } from "~/lib/logger.server";
import type { ShopifyOrderPaidPayload } from "~/types";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const rawBody = Buffer.from(await request.arrayBuffer());

  try {
    verifyWebhookHmac(rawBody, hmacHeader);
  } catch (error) {
    logger.warn("Webhook HMAC verification failed", { error: String(error) });
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: ShopifyOrderPaidPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    logger.error("Failed to parse webhook payload", { error: String(error) });
    return new Response("Bad Request", { status: 400 });
  }

  const customerId = payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null;
  const orderId = payload.id ? `gid://shopify/Order/${payload.id}` : null;

  if (!customerId || !orderId) {
    logger.warn("Cancelled order missing customer or order ID", { payloadId: payload.id });
    return new Response("OK", { status: 200 });
  }

  // Dedup specifically for cancellation to prevent double-processing the same cancellation
  const cancelClaimId = `${orderId}-cancel`;
  const claimed = await claimOrderSync(customerId, cancelClaimId);
  if (!claimed) {
    logger.info("Order cancellation already processed", { orderId });
    return new Response("OK", { status: 200 });
  }

  const rawLineItems = payload.line_items || [];
  const productGids = rawLineItems
    .filter((item) => item.product_id)
    .map((item) => `gid://shopify/Product/${item.product_id}`);

  if (productGids.length === 0) return new Response("OK", { status: 200 });

  const collectibleChecks = await checkProductsHaveCollectibleData(productGids);
  const collectibleIds = buildCollectibleProductIds(collectibleChecks);

  // Filter coins using shared logic (spec 4.2)
  const validCoins = filterCoinLineItems(rawLineItems, collectibleIds);

  if (validCoins.length === 0) return new Response("OK", { status: 200 });

  const aggregated = new Map<string, number>();
  for (const item of validCoins) {
    const gid = `gid://shopify/Product/${item.product_id}`;
    aggregated.set(gid, (aggregated.get(gid) || 0) + item.quantity);
  }

  let hasErrors = false;

  // Process decrements sequentially or via Promise.allSettled
  const results = await Promise.allSettled(
    Array.from(aggregated.entries()).map(async ([productId, cancelQty]) => {
      const existing = await findCollectionItemByProduct(customerId, productId);
      if (!existing) return;

      const newQty = existing.item.quantity_owned - cancelQty;

      if (newQty <= 0) {
        // Soft delete if quantity drops to 0 or below
        await deleteCollectionItem(customerId, existing.item.item_id);
      } else {
        // Just update the quantity
        await updateCollectionItem(customerId, existing.item.item_id, {
          quantity_owned: newQty,
        });
      }
    })
  );

  for (const result of results) {
    if (result.status === "rejected") {
      hasErrors = true;
      logger.error("Failed to decrement item in cancellation webhook", { error: String(result.reason) });
    }
  }

  try {
    await recalculateAndCacheStats(customerId);
  } catch (error) {
    logger.error("Failed to recalculate stats after cancellation", { error: String(error) });
  }

  return new Response(hasErrors ? "Processed with some errors" : "OK", { status: 200 });
}
