/**
 * app/lib/product-filter.server.ts
 *
 * Classifies Shopify order line items as collectible coins or non-collectible accessories.
 *
 * Design decisions:
 * - filterCoinLineItems() MUST always receive collectibleProductIds as the second argument.
 *   Without it, classification falls back to productType matching only — which silently
 *   drops real coins if Downies uses product_type names not in the hardcoded list.
 *   (The fallback list might exclude special collectible names).
 * - This function is applied to BOTH real-time webhook payloads AND historical batch sync.
 *   Any change here affects both code paths. See tech-lead-spec.md section 4.2.
 * - A product is KEPT if ANY inclusion criterion is met.
 * - A product is EXCLUDED if ANY exclusion criterion is met (exclusion takes priority).
 * - Shipping/fee lines have null product_id — always excluded.
 */

import { COLLECTIBLE_PRODUCT_TYPES, ACCESSORY_PRODUCT_TYPES, ACCESSORY_KEYWORDS } from "~/config/constants";
import type { ShopifyLineItem } from "~/types";

/**
 * Filter order line items to only collectible coins.
 *
 * IMPORTANT: collectibleProductIds MUST be fetched before calling this function
 * and passed as the second argument. Omitting it causes silent misclassification
 * of coins that don't match the hardcoded product type list.
 *
 * @param lineItems - Raw line items from the Shopify order.
 * @param collectibleProductIds - Set of product GIDs that have a collectible_data metafield.
 *   This is the primary classification signal. Product type list is the fallback.
 * @returns Line items that are confirmed collectible coins.
 */
export function filterCoinLineItems(
  lineItems: ShopifyLineItem[],
  collectibleProductIds: Set<string>
): ShopifyLineItem[] {
  return lineItems.filter((item) => {
    // Exclude shipping/fee lines — no product_id means not a real product
    if (item.product_id === null || item.product_id === undefined) {
      return false;
    }

    const productGid = `gid://shopify/Product/${item.product_id}`;
    const productTypeLower = (item.product_type ?? "").toLowerCase().trim();
    const titleLower = (item.title ?? "").toLowerCase();
    const vendorLower = (item.vendor ?? "").toLowerCase();

    // EXCLUSION: accessory product type (takes priority over inclusion)
    if (ACCESSORY_PRODUCT_TYPES.has(productTypeLower)) {
      return false;
    }

    // EXCLUSION: accessory keyword in title or vendor
    const hasAccessoryKeyword = ACCESSORY_KEYWORDS.some(
      (keyword) => titleLower.includes(keyword) || vendorLower.includes(keyword)
    );
    if (hasAccessoryKeyword) {
      return false;
    }

    // INCLUSION: has collectible_data metafield (primary signal — most reliable)
    if (collectibleProductIds.has(productGid)) {
      return true;
    }

    // INCLUSION: product type matches numismatic list (fallback — less reliable)
    if (COLLECTIBLE_PRODUCT_TYPES.has(productTypeLower)) {
      return true;
    }

    // Default: exclude if no inclusion criterion met
    return false;
  });
}

/**
 * Build the set of product GIDs that have a collectible_data metafield.
 * This should be called once per webhook/sync job, then passed to filterCoinLineItems.
 *
 * @param rawProductIds - Array of numeric product IDs from line items.
 * @param metafieldData - Map of product GID → whether metafield exists.
 * @returns Set of product GIDs confirmed to have collectible_data metafield.
 */
export function buildCollectibleProductIds(
  metafieldData: Array<{ productGid: string; hasCollectibleData: boolean }>
): Set<string> {
  const result = new Set<string>();
  for (const { productGid, hasCollectibleData } of metafieldData) {
    if (hasCollectibleData) {
      result.add(productGid);
    }
  }
  return result;
}
