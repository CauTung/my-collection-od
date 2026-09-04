/**
 * app/lib/batch-sync.server.ts
 *
 * Async historical batch sync engine.
 *
 * Design decisions:
 * - Async model: Starts a background job and updates progress via Customer Metafield.
 *   This avoids Vercel/Shopify timeout limits for large histories (Spec 4.5 & 11).
 * - Cross-customer limit: Uses queue.server.ts to enforce MAX_CONCURRENT_BATCH_SYNC_JOBS.
 * - Concurrency control: Processes items in chunks of BATCH_SYNC_CONCURRENCY using
 *   Promise.allSettled() to prevent N+1 sequential blocking.
 * - Exception isolation: Failure on one item does NOT abort the whole job.
 */

import {
  HISTORICAL_SYNC_MAX_ORDERS,
  HISTORICAL_SYNC_LOOKBACK_YEARS,
  BATCH_SYNC_CONCURRENCY,
} from "~/config/constants";
import { shopifyGraphQL } from "./graphql-client.server";
import { claimOrderSync } from "./dedup.server";
import { checkProductsHaveCollectibleData, updateCustomerSyncStateMetafields, type SyncProgress } from "./metafield.server";
import { upsertCollectionItemByProduct } from "./metaobject.server";
import { recalculateAndCacheStats } from "./stats.server";
import { acquireJobSlot, releaseJobSlot } from "./queue.server";
import { logger } from "./logger.server";
import { filterCoinLineItems, buildCollectibleProductIds } from "./product-filter.server";
import type { ShopifyLineItem } from "~/types";

interface BatchSyncOrdersResponse {
  orders?: {
    nodes?: Array<{
      id: string;
      createdAt: string;
      lineItems?: {
        nodes?: Array<{
          id: string;
          title: string;
          quantity: number;
          variant?: { price: string };
          product?: { id: string; productType: string };
        }>;
      };
    }>;
  };
}

interface AggregatedItem {
  productId: string;
  quantity: number;
  purchaseDate: string;
  purchasePrice: number;
  sourceOrderId: string;
}

/**
 * Triggers an async background sync job for a customer.
 * Returns immediately with the job status.
 */
export async function triggerBatchSync(customerId: string): Promise<string> {
  // Check cross-customer system limit
  if (!acquireJobSlot()) {
    await updateCustomerSyncStateMetafields(customerId, { sync_status: "queued" });
    return "queued";
  }

  // Update status to syncing
  // Note: We omit sync_progress here because runBatchSyncBackground sets it once items are found,
  // saving a redundant GraphQL mutation on startup.
  await updateCustomerSyncStateMetafields(customerId, {
    sync_status: "syncing",
  });

  // Start background processing (fire and forget)
  runBatchSyncBackground(customerId).catch((error) => {
    logger.error("Fatal error in background sync job", { customerId, error: String(error) });
  });

  return "syncing";
}

/**
 * The actual background processing logic.
 * MUST handle its own errors and release the job slot in finally block.
 */
async function runBatchSyncBackground(customerId: string): Promise<void> {
  const progress = { processed: 0, total: 0, failed: 0 };

  try {
    // 1. Calculate lookback date
    const lookbackDate = new Date();
    lookbackDate.setFullYear(lookbackDate.getFullYear() - HISTORICAL_SYNC_LOOKBACK_YEARS);
    const lookbackStr = lookbackDate.toISOString();

    // 2. Query historical orders
    // Note: customerId is a GID from the session layer, so it's safe from injection, but usually variables are preferred.
    const queryStr = `customer_id:'${customerId}' AND created_at:>'${lookbackStr}' AND financial_status:paid`;

    // In MVP, we fetch up to HISTORICAL_SYNC_MAX_ORDERS in one go. If more, we'd need pagination.
    const result = await shopifyGraphQL<BatchSyncOrdersResponse>(
      `query GetHistoricalOrders($query: String!, $first: Int!) {
        orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            createdAt
            lineItems(first: 250) {
              nodes {
                id
                title
                quantity
                variant { price }
                product { id productType }
              }
            }
          }
        }
      }`,
      { query: queryStr, first: HISTORICAL_SYNC_MAX_ORDERS }
    );

    const orders = result.data?.orders?.nodes || [];

    if (orders.length === 0) {
      await finishSync(customerId, progress, "completed");
      return;
    }

    // 3. Dedup orders and collect line items
    type SyncLineItem = ShopifyLineItem & {
      product_gid: string;
      order_id: string;
      created_at: string;
    };
    const rawLineItems: Array<SyncLineItem> = [];

    for (const order of orders) {
      // Dedup on order level
      let claimed = false;
      try {
        claimed = await claimOrderSync(customerId, order.id);
      } catch (error) {
        progress.failed++;
        logger.error("Failed to claim order during batch sync", { customerId, orderId: order.id, error: String(error) });
        continue; // Skip on unexpected failure so we don't drop silently, but isolated from rest of batch
      }

      if (!claimed) continue; // Skip already synced orders

      const items = order.lineItems?.nodes || [];
      for (const item of items) {
        if (item.product?.id) {
          rawLineItems.push({
            id: parseInt(item.id.split("/").pop() || "0", 10),
            product_id: parseInt(item.product.id.split("/").pop() || "0", 10),
            variant_id: null,
            title: item.title,
            quantity: item.quantity,
            price: item.variant?.price || "0",
            sku: null,
            vendor: null,
            product_type: item.product.productType || "",
            properties: [],
            product_gid: item.product.id,
            order_id: order.id,
            created_at: order.createdAt,
          });
        }
      }
    }

    if (rawLineItems.length === 0) {
      await finishSync(customerId, progress, "completed");
      return;
    }

    // 4. Filter coins using shared logic (spec 4.2)
    const uniqueProductGids = Array.from(new Set(rawLineItems.map((i) => i.product_gid)));
    const collectibleChecks = await checkProductsHaveCollectibleData(uniqueProductGids);
    const collectibleIds = buildCollectibleProductIds(collectibleChecks);

    const validCoins = filterCoinLineItems(rawLineItems, collectibleIds) as Array<SyncLineItem>;

    if (validCoins.length === 0) {
      await finishSync(customerId, progress, "completed");
      return;
    }

    // 5. Aggregate by product_id to prevent race conditions within the same batch
    const aggregated = new Map<string, AggregatedItem>();

    for (const item of validCoins) {
      const existing = aggregated.get(item.product_gid);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        aggregated.set(item.product_gid, {
          productId: item.product_gid,
          quantity: item.quantity,
          purchaseDate: item.created_at.split("T")[0],
          purchasePrice: parseFloat(item.price),
          sourceOrderId: item.order_id,
        });
      }
    }

    const itemsToUpsert = Array.from(aggregated.values());
    progress.total = itemsToUpsert.length;

    // Update progress early
    await updateCustomerSyncStateMetafields(customerId, { sync_progress: progress });

    // 6. Process in concurrent chunks
    // Note: We use Promise.allSettled instead of GraphQL Alias Batching here.
    // This is a deliberate tradeoff: it provides strong isolation (one item failure
    // doesn't fail the batch) and the async architecture removes strict timeout limits.
    for (let i = 0; i < itemsToUpsert.length; i += BATCH_SYNC_CONCURRENCY) {
      const chunk = itemsToUpsert.slice(i, i + BATCH_SYNC_CONCURRENCY);

      const results = await Promise.allSettled(
        chunk.map(item =>
          upsertCollectionItemByProduct(customerId, item.productId, {
            quantity_owned: item.quantity,
            purchase_date: item.purchaseDate,
            purchase_price: item.purchasePrice,
            source: "shopify_sync",
            external_order_id: item.sourceOrderId,
          })
        )
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          progress.processed++;
        } else {
          progress.failed++;
          logger.error("Failed to upsert item during batch sync", {
            customerId,
            error: String(result.reason)
          });
        }
      }

      // Update progress after each chunk
      await updateCustomerSyncStateMetafields(customerId, { sync_progress: progress });
    }

    // 7. Recalculate stats
    await recalculateAndCacheStats(customerId);

    // 8. Mark as completed
    await finishSync(customerId, progress, "completed");

  } catch (error) {
    logger.error("Batch sync failed abruptly", { customerId, error: String(error) });
    await finishSync(customerId, progress, "failed");
  } finally {
    // Release system-wide job slot
    releaseJobSlot();
  }
}

async function finishSync(
  customerId: string,
  progress: SyncProgress,
  status: "completed" | "failed"
) {
  await updateCustomerSyncStateMetafields(customerId, {
    sync_status: status,
    sync_progress: progress,
  });
  logger.info(`Batch sync ${status}`, { customerId, progress });
}
