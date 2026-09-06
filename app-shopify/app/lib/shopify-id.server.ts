/** Normalizes Shopify global IDs for handles and search filters. */

/**
 * Return the final non-empty segment of a Shopify GID.
 *
 * @param gid - Shopify GID such as `gid://shopify/Customer/123`.
 * @returns Numeric resource ID as a string.
 * @throws Error when the value is not a supported Shopify numeric GID.
 */
export function extractShopifyNumericId(gid: string): string {
  const numericId = gid.split("/").at(-1);
  if (!numericId || !/^\d+$/.test(numericId)) {
    throw new Error("Invalid Shopify numeric GID");
  }
  return numericId;
}

/** Return a safe final ID/event segment for normalized Metaobject handles. */
export function extractShopifyIdSegment(identifier: string): string {
  const segment = identifier.split("/").at(-1);
  if (!segment || !/^[A-Za-z0-9-]+$/.test(segment)) {
    throw new Error("Invalid Shopify ID segment");
  }
  return segment;
}
