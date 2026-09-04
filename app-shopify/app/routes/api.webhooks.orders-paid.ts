/**
 * app/routes/api.webhooks.orders-paid.ts
 *
 * Webhook handler for orders/paid.
 *
 * Design decisions:
 * - Uses HMAC verification.
 * - Extracts valid coins via filterCoinLineItems.
 * - Atomic dedup using claimOrderSync.
 * - Upserts by product_id to increment quantity.
 * - Exception isolation: failure on one item doesn't crash the whole webhook.
 */

import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookHmac } from "~/lib/hmac.server";
import { claimOrderSync } from "~/lib/dedup.server";
import { checkProductsHaveCollectibleData } from "~/lib/metafield.server";
import { upsertCollectionItemByProduct } from "~/lib/metaobject.server";
import { filterCoinLineItems, buildCollectibleProductIds } from "~/lib/product-filter.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { logger } from "~/lib/logger.server";
import type { ShopifyOrderPaidPayload } from "~/types";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");

  // Clone request to read body raw for HMAC, and json for parsing
  const rawBody = Buffer.from(await request.arrayBuffer());

  // verifyWebhookHmac throws AppError if invalid, handled by global boundary (if we had one)
  // But for webhooks, it's safer to catch and return 401 manually if we aren't using a wrapper.
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
    logger.warn("Order missing customer or order ID, skipping", { payloadId: payload.id });
    return new Response("OK", { status: 200 }); // Return 200 so Shopify doesn't retry
  }

  // 1. Atomic Deduplication
  const claimed = await claimOrderSync(customerId, orderId);
  if (!claimed) {
    logger.info("Order already processed (dedup locked)", { orderId });
    return new Response("OK", { status: 200 });
  }

  const rawLineItems = payload.line_items || [];

  // 2. Identify products
  const productGids = rawLineItems
    .filter((item) => item.product_id)
    .map((item) => `gid://shopify/Product/${item.product_id}`);

  if (productGids.length === 0) {
    return new Response("OK", { status: 200 });
  }

  const collectibleChecks = await checkProductsHaveCollectibleData(productGids);
  const collectibleIds = buildCollectibleProductIds(collectibleChecks);

  // 3. Filter coins using shared logic (spec 4.2)
  const validCoins = filterCoinLineItems(rawLineItems, collectibleIds);

  if (validCoins.length === 0) {
    return new Response("OK", { status: 200 });
  }

  // 4. Group by product to prevent race condition inside the same order
  const aggregated = new Map<string, { quantity: number; price: number }>();
  for (const item of validCoins) {
    const gid = `gid://shopify/Product/${item.product_id}`;
    const price = parseFloat(item.price || "0");
    const existing = aggregated.get(gid);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      aggregated.set(gid, { quantity: item.quantity, price });
    }
  }

  const purchaseDate = payload.created_at?.split("T")[0] || new Date().toISOString().split("T")[0];

  // 5. Upsert concurrently with isolation
  const results = await Promise.allSettled(
    Array.from(aggregated.entries()).map(([productId, data]) =>
      upsertCollectionItemByProduct(customerId, productId, {
        quantity_owned: data.quantity,
        purchase_date: purchaseDate,
        purchase_price: data.price,
        source: "shopify_sync",
        external_order_id: orderId,
      })
    )
  );

  let hasErrors = false;
  for (const result of results) {
    if (result.status === "rejected") {
      hasErrors = true;
      logger.error("Failed to upsert item in webhook", { error: String(result.reason) });
    }
  }

  // 6. Recalculate stats
  try {
    await recalculateAndCacheStats(customerId);
  } catch (error) {
    logger.error("Failed to recalculate stats in webhook", { error: String(error) });
  }

  // Even if some items failed, we return 200 OK.
  // The dedup lock is placed, so Shopify won't retry.
  // This is a trade-off: we prefer losing a single item over re-running the entire order
  // and risking duplicate items if upsert isn't perfectly idempotent under extreme failure.
  return new Response(hasErrors ? "Processed with some errors" : "OK", { status: 200 });
}
