/** Builds safe Shopify Metaobject field-search expressions. */

const METAOBJECT_FIELD_KEY_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Build one exact field filter using Shopify's `fields.{key}:"value"` syntax.
 * Quotes and backslashes are escaped so authenticated IDs and future caller values
 * cannot alter the search expression.
 */
export function buildMetaobjectFieldFilter(fieldKey: string, value: string): string {
  if (!METAOBJECT_FIELD_KEY_PATTERN.test(fieldKey)) {
    throw new Error("Invalid metaobject field key");
  }

  const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `fields.${fieldKey}:"${escapedValue}"`;
}
