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
import { COLLECTION_ITEM_METAOBJECT_TYPE, METAOBJECT_MAX_PAGE_SIZE } from "~/config/constants";
import { buildMetaobjectFieldFilter } from "./metaobject-search.server";
import type { CollectionItem } from "~/types";

interface StatsResponse {
  metaobjects?: {
    nodes?: Array<{ fields?: Array<{ key: string; value: string | null }> }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Recalculate stats by fetching all active items for a customer and summing them up.
 * Caches the result in Customer Metafields.
 * @param customerId - Owner of the collection to aggregate.
 * @param authoritativeItem - A just-created or updated item that must override a
 * potentially stale Metaobject search result while Shopify indexing catches up.
 * @returns Validated totals after a successful cache write.
 * @throws If reads fail, ownership or pagination is invalid, or values are malformed.
 * Cache writes occur only after the entire collection has been validated.
 */
export async function recalculateAndCacheStats(
  customerId: string,
  authoritativeItem?: CollectionItem
): Promise<CustomerStats> {
  let hasNextPage = true;
  let cursor: string | null = null;
  let totalItemsCount = 0;
  let totalValueSum = 0;
  let authoritativeItemSeen = false;
  const seenCursors = new Set<string>();
  const authoritativeContribution = authoritativeItem
    ? getAuthoritativeItemContribution(authoritativeItem, customerId)
    : undefined;

  const queryStr = [
    buildMetaobjectFieldFilter("customer_id", customerId),
    buildMetaobjectFieldFilter("is_deleted", "false"),
  ].join(" AND ");

  try {
    // A failed old-cache read cannot safely establish first-time loyalty eligibility.
    const { stats: oldStats } = await getCustomerCollectionMetafields(customerId);
    while (hasNextPage) {
      const result: import("~/types").ShopifyGraphQLResponse<StatsResponse> = await shopifyGraphQL<StatsResponse>(
        `query CalculateStats($query: String!, $after: String) {
          metaobjects(type: "${COLLECTION_ITEM_METAOBJECT_TYPE}", first: ${METAOBJECT_MAX_PAGE_SIZE}, after: $after, query: $query) {
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

      const connection = result.data?.metaobjects;
      if (!connection || !Array.isArray(connection.nodes) ||
          typeof connection.pageInfo?.hasNextPage !== "boolean") {
        throw new Error("Stats response is missing a valid collection page");
      }
      for (const node of connection.nodes) {
        if (!node || !Array.isArray(node.fields)) throw new Error("Stats item fields are missing");
        const fields = new Map<string, string>();
        for (const field of node.fields) {
          if (!field || typeof field.key !== "string" || fields.has(field.key)) {
            throw new Error("Stats item fields are malformed");
          }
          // Shopify Admin GraphQL returns nullable field values (value: null) for unset optional fields.
          if (field.value !== null && field.value !== undefined) {
            if (typeof field.value !== "string") {
              throw new Error("Stats item fields are malformed");
            }
            fields.set(field.key, field.value);
          }
        }
        // Shopify search is not the only ownership boundary: validate every returned record.
        if (fields.get("customer_id") !== customerId || fields.get("is_deleted") !== "false") {
          throw new Error("Stats item ownership or active status is invalid");
        }
        let quantity: number;
        let value: number;
        if (authoritativeItem && fields.get("item_id") === authoritativeItem.item_id) {
          if (authoritativeItemSeen) throw new Error("Stats contains a duplicate authoritative item");
          authoritativeItemSeen = true;
          ({ quantity, value } = authoritativeContribution!);
        } else {
          quantity = parseStatsNumber(fields.get("quantity_owned"));
          if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Stats quantity is invalid");
          const marketValue = fields.get("current_market_value");
          const purchasePrice = fields.get("purchase_price");
          value = marketValue !== undefined ? parseStatsNumber(marketValue)
            : purchasePrice !== undefined ? parseStatsNumber(purchasePrice) : 0;
        }
        totalItemsCount += quantity;
        totalValueSum += value * quantity;
        if (!Number.isSafeInteger(totalItemsCount) || !Number.isFinite(totalValueSum)) {
          throw new Error("Stats totals exceed supported numeric range");
        }
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      const nextCursor = connection.pageInfo.endCursor;
      if (nextCursor !== null && typeof nextCursor !== "string") throw new Error("Stats cursor is malformed");
      if (hasNextPage && (!nextCursor || seenCursors.has(nextCursor))) {
        throw new Error("Stats pagination cursor did not advance");
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;

    }

    // Metaobject search indexing can lag behind a successful create mutation. Include
    // the saved item explicitly when it is not present in the freshly scanned pages.
    if (authoritativeContribution && !authoritativeItemSeen) {
      totalItemsCount += authoritativeContribution.quantity;
      totalValueSum += authoritativeContribution.value * authoritativeContribution.quantity;
      if (!Number.isSafeInteger(totalItemsCount) || !Number.isFinite(totalValueSum)) {
        throw new Error("Stats totals exceed supported numeric range");
      }
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

function getAuthoritativeItemContribution(
  item: CollectionItem,
  customerId: string
): { quantity: number; value: number } {
  if (!item.item_id || item.customer_id !== customerId || item.is_deleted) {
    throw new Error("Authoritative stats item ownership or active status is invalid");
  }
  if (!Number.isSafeInteger(item.quantity_owned) || item.quantity_owned < 1) {
    throw new Error("Authoritative stats quantity is invalid");
  }
  const value = item.current_market_value ?? item.purchase_price ?? 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Authoritative stats value is invalid");
  }
  return { quantity: item.quantity_owned, value };
}

/** Parse a complete nonnegative decimal; partial parses must never poison cached totals. */
function parseStatsNumber(value: string | undefined): number {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Stats numeric field is malformed");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Stats numeric field is not finite");
  return parsed;
}
