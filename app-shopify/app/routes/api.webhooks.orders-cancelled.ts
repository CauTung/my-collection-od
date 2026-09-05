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
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { claimOrderSync } from "~/lib/dedup.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { decrementCollectionItemByProduct } from "~/lib/metaobject.server";
import { filterCoinLineItems, buildCollectibleProductIds } from "~/lib/product-filter.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { logger } from "~/lib/logger.server";
import type { ShopifyOrderCancelledPayload } from "~/types";

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const payload = await authenticateWebhookRequest<ShopifyOrderCancelledPayload>(
    request,
    "orders/cancelled"
  );

  const customerId = payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null;
  const orderId = payload.id ? `gid://shopify/Order/${payload.id}` : null;

  if (!customerId || !orderId) {
    logger.warn("Cancelled order missing customer or order ID", { payloadId: payload.id });
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

  const cancelClaimId = `${orderId}-cancel`;
  const claimed = await claimOrderSync(customerId, cancelClaimId);
  if (!claimed) {
    logger.info("Order cancellation already processed", { orderId });
    return new Response("OK", { status: 200 });
  }

  let hasErrors = false;

  // Process decrements sequentially or via Promise.allSettled
  const results = await Promise.allSettled(
    Array.from(aggregated.entries()).map(([productId, cancelQty]) =>
      decrementCollectionItemByProduct(customerId, productId, cancelQty)
    )
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

export const action = withErrorHandler(actionHandler);
