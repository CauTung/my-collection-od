/**
 * app/routes/api.webhooks.refunds-create.ts
 *
 * Webhook handler for refunds/create.
 *
 * Design decisions:
 * - Uses HMAC verification.
 * - Extracts valid coins from refund_line_items.
 * - Atomic dedup using claimOrderSync with a refund-specific prefix.
 * - Decrements quantity_owned by the refunded amount. If quantity <= 0, soft deletes the item.
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
import { getOrderCustomerId } from "~/lib/order.server";
import type { ShopifyRefundPayload } from "~/types";
import { mapSettledInChunks } from "~/lib/concurrency.server";
import { WEBHOOK_MUTATION_CONCURRENCY } from "~/config/constants";

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const payload = await authenticateWebhookRequest<ShopifyRefundPayload>(
    request,
    "refunds/create"
  );

  const orderId = payload.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  const refundId = payload.id;

  if (!orderId || !refundId) {
    logger.warn("Refund missing order ID or refund ID", { payloadId: payload.id });
    return new Response("OK", { status: 200 });
  }

  const customerId = await getOrderCustomerId(orderId);

  if (!customerId) {
    logger.warn("Refund payload missing customer ID. Skipping processing.", { refundId });
    return new Response("OK", { status: 200 });
  }

  const refundLineItems = payload.refund_line_items || [];

  const rawLineItems = refundLineItems
    .map((rli) => ({
      product_id: rli.line_item?.product_id,
      product_type: rli.line_item?.product_type,
      quantity: rli.quantity,
    }))
    .filter((item) => item.product_id);

  if (rawLineItems.length === 0) return new Response("OK", { status: 200 });

  const productGids = rawLineItems.map((item) => `gid://shopify/Product/${item.product_id}`);

  const collectibleChecks = await checkProductsHaveCollectibleData(productGids);
  // rawLineItems is mapped from refund_line_items, we need it to match ShopifyLineItem shape
  const mappedLineItems = rawLineItems.map((item) => ({
    id: 0,
    product_id: item.product_id ? Number(item.product_id) : null,
    variant_id: null,
    title: "", // Not available in the simple mapping, but filterCoinLineItems checks title for exclusions, it will just pass
    quantity: item.quantity,
    price: "0",
    sku: null,
    vendor: null,
    product_type: item.product_type || "",
    properties: [],
  }));

  const collectibleIds = buildCollectibleProductIds(collectibleChecks);
  const validCoins = filterCoinLineItems(mappedLineItems, collectibleIds);

  if (validCoins.length === 0) return new Response("OK", { status: 200 });

  const aggregated = new Map<string, number>();
  for (const item of validCoins) {
    const gid = `gid://shopify/Product/${item.product_id}`;
    aggregated.set(gid, (aggregated.get(gid) || 0) + item.quantity);
  }

  const refundClaimId = `refund-${refundId}`;
  const claimed = await claimOrderSync(customerId, refundClaimId);
  if (!claimed) {
    logger.info("Refund already processed", { refundId });
    return new Response("OK", { status: 200 });
  }

  let hasErrors = false;

  const results = await mapSettledInChunks(
    Array.from(aggregated.entries()),
    WEBHOOK_MUTATION_CONCURRENCY,
    ([productId, refundQty]) =>
      decrementCollectionItemByProduct(customerId, productId, refundQty)
  );

  for (const result of results) {
    if (result.status === "rejected") {
      hasErrors = true;
      logger.error("Failed to decrement item in refund webhook", { error: String(result.reason) });
    }
  }

  try {
    await recalculateAndCacheStats(customerId);
  } catch (error) {
    logger.error("Failed to recalculate stats after refund", { error: String(error) });
  }

  return new Response(hasErrors ? "Processed with some errors" : "OK", { status: 200 });
}

export const action = withErrorHandler(actionHandler);
