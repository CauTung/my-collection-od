/**
 * app/lib/metafield.server.ts
 *
 * CRUD operations for Shopify Customer and Product Metafields.
 *
 * Design decisions:
 * - Customer Metafields ("my_collection" namespace) store cached aggregate stats
 *   and batch sync progress to avoid O(N) scanning of metaobjects.
 * - Product Metafields ("collectible_data" namespace) store numismatic attributes
 *   and act as the primary signal for filterCoinLineItems.
 * - All queries/mutations go through shopifyGraphQL().
 */

import { shopifyGraphQL } from "./graphql-client.server";
import { AppError } from "./error-handler.server";
import { ErrorCode } from "~/types";
import { logger } from "./logger.server";

// ─── Customer Metafields (Stats & Sync Status) ───────────────────────────────

const CUSTOMER_NAMESPACE = "my_collection";

export interface CustomerStats {
  total_items: number;
  total_value: number;
}

export interface SyncProgress {
  processed: number;
  total: number;
  failed: number;
}

export interface CustomerSyncState {
  sync_status: "idle" | "syncing" | "queued" | "completed" | "failed";
  sync_progress: SyncProgress | null;
  last_updated: string | null;
}

/**
 * Fetch cached stats and sync status for a customer.
 */
export async function getCustomerCollectionMetafields(
  customerId: string
): Promise<{ stats: CustomerStats; syncState: CustomerSyncState }> {
  const query = `
    query GetCustomerMetafields($id: ID!) {
      customer(id: $id) {
        totalItems: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "total_items") { value }
        totalValue: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "total_value") { value }
        syncStatus: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "sync_status") { value }
        syncProgress: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "sync_progress") { value }
        lastUpdated: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "last_updated") { value }
      }
    }
  `;

  const response = await shopifyGraphQL<{
    customer: {
      totalItems?: { value: string };
      totalValue?: { value: string };
      syncStatus?: { value: string };
      syncProgress?: { value: string };
      lastUpdated?: { value: string };
    } | null;
  }>(query, { id: customerId });

  const customer = response.data?.customer;
  if (!customer) {
    throw new AppError(ErrorCode.CUSTOMER_NOT_AUTHENTICATED, "Customer not found");
  }

  let syncProgress: SyncProgress | null = null;
  if (customer.syncProgress?.value) {
    try {
      syncProgress = JSON.parse(customer.syncProgress.value) as SyncProgress;
    } catch {
      logger.warn("Failed to parse sync_progress metafield", { customerId });
    }
  }

  return {
    stats: {
      total_items: parseInt(customer.totalItems?.value || "0", 10),
      total_value: parseFloat(customer.totalValue?.value || "0"),
    },
    syncState: {
      sync_status: (customer.syncStatus?.value as CustomerSyncState["sync_status"]) || "idle",
      sync_progress: syncProgress,
      last_updated: customer.lastUpdated?.value || null,
    },
  };
}

/**
 * Update customer stats (called after CRUD operations).
 */
export async function updateCustomerStatsMetafields(
  customerId: string,
  stats: CustomerStats
): Promise<void> {
  const mutation = `
    mutation UpdateCustomerStats($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: customerId,
        namespace: CUSTOMER_NAMESPACE,
        key: "total_items",
        value: stats.total_items.toString(),
        type: "number_integer",
      },
      {
        ownerId: customerId,
        namespace: CUSTOMER_NAMESPACE,
        key: "total_value",
        value: stats.total_value.toString(),
        type: "number_decimal",
      },
      {
        ownerId: customerId,
        namespace: CUSTOMER_NAMESPACE,
        key: "last_updated",
        value: new Date().toISOString(),
        type: "date_time",
      },
    ],
  };

  const response = await shopifyGraphQL<{
    metafieldsSet: { userErrors: Array<{ message: string }> };
  }>(mutation, variables);

  const errors = response.data?.metafieldsSet?.userErrors || [];
  if (errors.length > 0) {
    logger.error("Failed to update customer stats metafields", { errors, customerId });
    // Don't throw — stats update failure shouldn't crash the main operation,
    // but we log it as an error because stats will be out of sync.
  }
}

/**
 * Update customer sync status and progress.
 */
export async function updateCustomerSyncStateMetafields(
  customerId: string,
  state: Partial<CustomerSyncState>
): Promise<void> {
  const metafields = [];

  if (state.sync_status) {
    metafields.push({
      ownerId: customerId,
      namespace: CUSTOMER_NAMESPACE,
      key: "sync_status",
      value: state.sync_status,
      type: "single_line_text_field",
    });
  }

  if (state.sync_progress !== undefined) {
    metafields.push({
      ownerId: customerId,
      namespace: CUSTOMER_NAMESPACE,
      key: "sync_progress",
      value: state.sync_progress ? JSON.stringify(state.sync_progress) : "",
      type: "json",
    });
  }

  if (metafields.length === 0) return;

  const mutation = `
    mutation UpdateCustomerSyncState($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  await shopifyGraphQL(mutation, { metafields });
}

// ─── Product Metafields (Collectible Data) ───────────────────────────────────

const PRODUCT_NAMESPACE = "collectible_data";
// Fallback if Downies uses a different namespace structure
const PRODUCT_NAMESPACE_FALLBACK = "downies_product_data";

export interface CollectibleData {
  denomination?: string;
  country_of_issue?: string;
  material?: string;
  year_of_issue?: string;
  issuer?: string;
  quality?: string;
  grade?: string;
  limited_mintage?: string;
  mintage_limit?: string;
  erp_sku?: string;
}

/**
 * Check which product GIDs have collectible data metafields.
 * Used by product-filter.server.ts to identify coins.
 * Uses alias batching to fetch multiple products in one query.
 */
export async function checkProductsHaveCollectibleData(
  productGids: string[]
): Promise<Array<{ productGid: string; hasCollectibleData: boolean }>> {
  if (productGids.length === 0) return [];

  // Build a query with aliases for each product ID
  // e.g., prod_123: product(id: "gid://...") { metafield(...) { value } }
  let query = "query CheckCollectibleData {\n";
  const variables: Record<string, string> = {};

  productGids.forEach((gid, index) => {
    const id = gid.split("/").pop()!;
    const alias = `prod_${id}`;
    // Using both namespaces to be safe
    query += `
      ${alias}: product(id: $id_${index}) {
        m1: metafield(namespace: "${PRODUCT_NAMESPACE}", key: "year_of_issue") { value }
        m2: metafield(namespace: "${PRODUCT_NAMESPACE_FALLBACK}", key: "year_of_issue") { value }
      }
    `;
    variables[`id_${index}`] = gid;
  });

  query += "}";

  // Add variable declarations to the query string
  const varDecls = productGids.map((_, i) => `$id_${i}: ID!`).join(", ");
  query = query.replace("query CheckCollectibleData {", `query CheckCollectibleData(${varDecls}) {`);

  const response = await shopifyGraphQL<Record<string, { m1?: { value: string }; m2?: { value: string } } | null>>(
    query,
    variables
  );

  const data = response.data || {};
  
  return productGids.map((gid) => {
    const id = gid.split("/").pop()!;
    const alias = `prod_${id}`;
    const productNode = data[alias];
    
    // If ANY of the target metafields exist, it's a collectible
    const hasCollectibleData = !!(productNode && (productNode.m1 || productNode.m2));
    
    return {
      productGid: gid,
      hasCollectibleData,
    };
  });
}
