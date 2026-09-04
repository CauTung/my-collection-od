/**
 * app/lib/stats.server.ts
 *
 * Calculate and cache collection statistics for a customer.
 *
 * Design decisions:
 * - Stats (total_items, total_value) are calculated by scanning all active
 *   collection_item metaobjects for the customer, then cached in Customer Metafields.
 * - This prevents expensive O(N) scanning on every dashboard load.
 * - Called after any manual CRUD operation or at the end of a Batch Sync job.
 */

import { shopifyGraphQL } from "./graphql-client.server";
import { updateCustomerStatsMetafields, getCustomerCollectionMetafields } from "./metafield.server";
import type { CustomerStats } from "./metafield.server";
import { logger } from "./logger.server";
import { awardLoyaltyPoints } from "./integrations/yotpo.server";
import { syncCustomerToKlaviyo } from "./integrations/klaviyo.server";

const ITEM_TYPE = "collection_item";

interface StatsResponse {
  metaobjects?: {
    nodes?: Array<{ fields?: Array<{ key: string; value: string }> }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Recalculate stats by fetching all active items for a customer and summing them up.
 * Caches the result in Customer Metafields.
 * Handles pagination if the customer has more than 250 items.
 */
export async function recalculateAndCacheStats(customerId: string): Promise<CustomerStats> {
  let hasNextPage = true;
  let cursor: string | null = null;
  let totalItemsCount = 0;
  let totalValueSum = 0;

  // Fetch old stats to detect first-time collection creation for Yotpo
  const { stats: oldStats } = await getCustomerCollectionMetafields(customerId).catch(() => ({ 
    stats: { total_items: 0, total_value: 0 } 
  }));

  const queryStr = `customer_id:'${customerId}' AND is_deleted:'false'`;

  try {
    while (hasNextPage) {
      const result: import("~/types").ShopifyGraphQLResponse<StatsResponse> = await shopifyGraphQL<StatsResponse>(
        `query CalculateStats($query: String!, $after: String) {
          metaobjects(type: "${ITEM_TYPE}", first: 250, after: $after, query: $query) {
            nodes {
              fields { key value }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
        { query: queryStr, after: cursor }
      );

      const nodes = result.data?.metaobjects?.nodes || [];
      
      for (const node of nodes) {
        const fields = node.fields || [];
        
        // Find quantity
        const qtyField = fields.find((f) => f.key === "quantity_owned");
        const quantity = parseInt(qtyField?.value || "1", 10);
        
        // Find current market value (or purchase price as fallback for stats calculation)
        const cmvField = fields.find((f) => f.key === "current_market_value");
        const ppField = fields.find((f) => f.key === "purchase_price");
        
        const value = parseFloat(cmvField?.value || ppField?.value || "0");

        totalItemsCount += quantity;
        totalValueSum += (value * quantity);
      }

      const pageInfo = result.data?.metaobjects?.pageInfo;
      hasNextPage = pageInfo?.hasNextPage || false;
      cursor = pageInfo?.endCursor || null;
    }

    const stats: CustomerStats = {
      total_items: totalItemsCount,
      total_value: Number(totalValueSum.toFixed(2)),
    };

    // Cache the result
    await updateCustomerStatsMetafields(customerId, stats);
    
    logger.info("Stats recalculated and cached", { customerId, stats });
    
    // ─── Integrations (Non-blocking) ───
    
    // Klaviyo Sync
    syncCustomerToKlaviyo(customerId, {
      totalCollectionItems: stats.total_items,
      totalCollectionValue: stats.total_value,
    }).catch(err => logger.error("Klaviyo integration error", { error: String(err) }));

    // Yotpo first-time bonus
    if (oldStats.total_items === 0 && stats.total_items > 0) {
      awardLoyaltyPoints(customerId, "first_item_added").catch(err => 
        logger.error("Yotpo integration error", { error: String(err) })
      );
    }

    return stats;

  } catch (error) {
    logger.error("Failed to recalculate stats", { customerId, error: String(error) });
    // Rethrow to let caller decide whether to swallow or fail
    throw error;
  }
}
