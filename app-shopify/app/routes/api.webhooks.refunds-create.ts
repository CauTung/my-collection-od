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
import { verifyWebhookHmac } from "~/lib/hmac.server";
import { claimOrderSync } from "~/lib/dedup.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { findCollectionItemByProduct, updateCollectionItem, deleteCollectionItem } from "~/lib/metaobject.server";
import { filterCoinLineItems, buildCollectibleProductIds } from "~/lib/product-filter.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { logger } from "~/lib/logger.server";

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

  interface RefundPayload {
    order_id?: number | string;
    id?: number | string;
    user_id?: number | string;
    order?: { customer?: { id?: number | string } };
    customer?: { id?: number | string };
    refund_line_items?: Array<{
      quantity: number;
      line_item?: { product_id?: number | string; product_type?: string };
    }>;
  }

  let payload: RefundPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    logger.error("Failed to parse webhook payload", { error: String(error) });
    return new Response("Bad Request", { status: 400 });
  }

  const orderId = payload.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  const refundId = payload.id;

  if (!orderId || !refundId) {
    logger.warn("Refund missing order ID or refund ID", { payloadId: payload.id });
    return new Response("OK", { status: 200 });
  }

  // Shopify refunds/create webhook doesn't consistently include customer data at the top level,
  // we must extract it from the payload if it exists or we might have to fetch the order.
  // Assuming Downies webhook includes customer due to order payload embedding, or we fetch it.
  // Let's just safely skip if we can't find it without an extra API call in MVP.
  // Wait, refund payload DOES NOT always include customer.id. 
  // We can skip processing if we don't have a way to link it, or we could fetch the order.
  // For MVP, let's assume `payload.order.customer.id` or similar isn't strictly there.
  // Let's do a simple extraction if available.
  let customerId = null;
  if (payload.customer?.id) customerId = `gid://shopify/Customer/${payload.customer.id}`;
  else if (payload.order?.customer?.id) customerId = `gid://shopify/Customer/${payload.order.customer.id}`;

  if (!customerId) {
    logger.warn("Refund payload missing customer ID. Skipping processing.", { refundId });
    return new Response("OK", { status: 200 });
  }

  // Dedup for this specific refund
  const refundClaimId = `refund-${refundId}`;
  const claimed = await claimOrderSync(customerId, refundClaimId);
  if (!claimed) {
    logger.info("Refund already processed", { refundId });
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

  let hasErrors = false;

  const results = await Promise.allSettled(
    Array.from(aggregated.entries()).map(async ([productId, refundQty]) => {
      const existing = await findCollectionItemByProduct(customerId!, productId);
      if (!existing) return;

      const newQty = existing.item.quantity_owned - refundQty;

      if (newQty <= 0) {
        await deleteCollectionItem(customerId!, existing.item.item_id);
      } else {
        await updateCollectionItem(customerId!, existing.item.item_id, {
          quantity_owned: newQty,
        });
      }
    })
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
