/**
 * app/lib/batch-sync.server.ts
 *
 * Async historical batch sync engine.
 *
 * Design decisions:
 * - Async model: Starts a registered background job and updates progress via Customer Metafield.
 *   Vercel waitUntil preserves post-response work but does not extend the function timeout.
 * - Cross-customer limit: Uses queue.server.ts to enforce MAX_CONCURRENT_BATCH_SYNC_JOBS.
 * - Concurrency control: Processes items in chunks of BATCH_SYNC_CONCURRENCY using
 *   Promise.allSettled() to prevent N+1 sequential blocking.
 * - Exception isolation: Failure on one item does NOT abort the whole job.
 */

import {
  HISTORICAL_SYNC_MAX_ORDERS,
  HISTORICAL_SYNC_LOOKBACK_YEARS,
  BATCH_SYNC_CONCURRENCY,
  ORDER_LINE_ITEM_PAGE_SIZE,
} from "~/config/constants";
import { shopifyGraphQL } from "./graphql-client.server";
import { claimOrderSync } from "./dedup.server";
import { checkProductsHaveCollectibleData, updateCustomerSyncStateMetafields, type SyncProgress } from "./metafield.server";
import { upsertCollectionItemByProduct } from "./metaobject.server";
import { recalculateAndCacheStats } from "./stats.server";
import { scheduleJob, type ScheduledJob } from "./queue.server";
import { logger } from "./logger.server";
import { filterCoinLineItems, buildCollectibleProductIds } from "./product-filter.server";
import type { ShopifyLineItem } from "~/types";
import { extractShopifyNumericId } from "./shopify-id.server";
import { mapSettledInChunks } from "./concurrency.server";

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
 * @param customerId - Authenticated Shopify customer GID.
 * @returns The current queue state and the promise for the full job lifecycle.
 * @throws When the queued state cannot be persisted for a newly admitted job.
 */
export async function triggerBatchSync(customerId: string): Promise<ScheduledJob> {
  const emptyProgress: SyncProgress = { processed: 0, total: 0, failed: 0 };
  return scheduleJob(
    customerId,
    () => updateCustomerSyncStateMetafields(customerId, {
      sync_status: "queued",
      sync_progress: emptyProgress,
    }),
    async () => {
      try {
        await updateCustomerSyncStateMetafields(customerId, {
          sync_status: "syncing",
          sync_progress: emptyProgress,
        });
      } catch (error) {
        try {
          await finishSync(customerId, emptyProgress, "failed");
        } catch (terminalStateError) {
          logger.error("Failed to persist terminal state after sync admission failure", {
            customerId,
            error: String(terminalStateError),
          });
        }
        throw error;
      }
      await runBatchSyncBackground(customerId);
    }
  );
}

/**
 * Execute the historical sync and persist a terminal customer state.
 * The queue owns slot release after this function settles.
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
    const numericCustomerId = extractShopifyNumericId(customerId);
    const queryStr = `customer_id:${numericCustomerId} AND created_at:>'${lookbackStr}' AND financial_status:paid`;

    // In MVP, we fetch up to HISTORICAL_SYNC_MAX_ORDERS in one go. If more, we'd need pagination.
    const result = await shopifyGraphQL<BatchSyncOrdersResponse>(
      `query GetHistoricalOrders($query: String!, $first: Int!) {
        orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            createdAt
            lineItems(first: ${ORDER_LINE_ITEM_PAGE_SIZE}) {
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

    const orderConnection = result.data?.orders;
    if (!orderConnection) {
      throw new Error("Shopify did not return the historical orders payload");
    }
    const orders = orderConnection.nodes ?? [];

    if (orders.length === 0) {
      await finishSync(customerId, progress, "completed");
      return;
    }

    // 3. Collect candidates before claiming orders. Product lookup failures must not
    // leave permanent order claims when no collection mutation has started.
    type SyncLineItem = ShopifyLineItem & {
      product_gid: string;
      order_id: string;
      created_at: string;
    };
    const rawLineItems: Array<SyncLineItem> = [];

    for (const order of orders) {
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

    const coinsByOrder = new Map<string, Array<SyncLineItem>>();
    for (const item of validCoins) {
      const orderItems = coinsByOrder.get(item.order_id) ?? [];
      orderItems.push(item);
      coinsByOrder.set(item.order_id, orderItems);
    }

    const claimResults = await mapSettledInChunks(
      Array.from(coinsByOrder.entries()),
      BATCH_SYNC_CONCURRENCY,
  ORDER_LINE_ITEM_PAGE_SIZE,
      async ([orderId, items]) => ({
        items,
        claimed: await claimOrderSync(customerId, orderId),
      })
    );
    const claimedCoins: Array<SyncLineItem> = [];
    for (const result of claimResults) {
      if (result.status === "fulfilled") {
        progress.processed += 1;
        if (result.value.claimed) claimedCoins.push(...result.value.items);
      } else {
        progress.failed += 1;
        logger.error("Failed to claim order during batch sync", {
          customerId,
          error: String(result.reason),
        });
      }
    }

    if (claimedCoins.length === 0) {
      progress.total = coinsByOrder.size;
      await finishSync(customerId, progress, progress.failed > 0 ? "failed" : "completed");
      return;
    }

    // 5. Aggregate claimed items by product_id to prevent races within the same batch.
    const aggregated = new Map<string, AggregatedItem>();

    for (const item of claimedCoins) {
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
    progress.total = coinsByOrder.size + itemsToUpsert.length;

    // Update progress early
    await updateCustomerSyncStateMetafields(customerId, { sync_progress: progress });

    // 6. Process in concurrent chunks
    // Note: We use Promise.allSettled instead of GraphQL Alias Batching here.
    // This provides item-level exception isolation while keeping concurrency bounded.
    // The registered background task remains subject to the hosting function timeout.
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
    await finishSync(customerId, progress, progress.failed > 0 ? "failed" : "completed");

  } catch (error) {
    logger.error("Batch sync failed abruptly", { customerId, error: String(error) });
    await finishSync(customerId, progress, "failed");
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
