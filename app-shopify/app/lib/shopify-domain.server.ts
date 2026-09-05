/**
 * Normalizes the shop domain used for Shopify Admin API requests.
 *
 * Environment dashboards commonly encourage pasting a full URL, while Shopify
 * Admin API clients require a hostname. Keeping this conversion in one module
 * prevents malformed URLs such as `https://https://shop.myshopify.com` during
 * either the Vercel build setup step or runtime API calls.
 */

/**
 * Convert a Shopify shop URL or hostname to its canonical hostname.
 *
 * @param value - A `*.myshopify.com` hostname, optionally prefixed by `https://`.
 * @returns A lowercase `*.myshopify.com` hostname with no protocol or path.
 * @throws Error if the value is not a valid Shopify shop domain.
 */
export function normalizeShopifyShopDomain(value: string): string {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error("SHOPIFY_SHOP_DOMAIN must not be empty.");
  }

  let url: URL;
  try {
    url = new URL(
      trimmedValue.includes("://") ? trimmedValue : `https://${trimmedValue}`
    );
  } catch {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN must be a Shopify hostname such as my-shop.myshopify.com."
    );
  }

  const hasUnsupportedUrlParts =
    url.protocol !== "https:" ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    Boolean(url.port) ||
    url.pathname !== "/" ||
    Boolean(url.search) ||
    Boolean(url.hash);

  if (hasUnsupportedUrlParts || !url.hostname.endsWith(".myshopify.com")) {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN must be a Shopify hostname such as my-shop.myshopify.com; do not include an API path or query string."
    );
  }

  return url.hostname.toLowerCase();
}
