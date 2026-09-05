/**
 * app/lib/session.server.ts
 *
 * Extracts and validates customer session from Shopify App Proxy requests.
 *
 * Design decisions:
 * - App Proxy requests include `logged_in_customer_id` as a query parameter when
 *   the visitor is logged in to Shopify storefront. No additional auth handshake needed —
 *   the App Proxy HMAC (verified by hmac.server.ts) already proves the request is from Shopify.
 * - We normalize the raw numeric ID to Shopify GID format: gid://shopify/Customer/{id}.
 * - If the customer is not logged in (missing or empty logged_in_customer_id), we throw
 *   AppError(CUSTOMER_NOT_AUTHENTICATED). Routes should not proceed without a valid session.
 * - Signature verification and session extraction are one operation, preventing routes
 *   from trusting customer query parameters before authentication.
 */

import { AppError } from "./error-handler.server";
import { verifyAppProxyHmac } from "./hmac.server";
import { normalizeShopifyShopDomain } from "./shopify-domain.server";
import { ErrorCode } from "~/types";
import type { AppProxyContext } from "~/types";

/**
 * Verifies and extracts App Proxy context from an incoming request.
 *
 * @param request - The incoming Remix Request object from an App Proxy route.
 * @returns AppProxyContext with normalized customer GID.
 * @throws AppError(HMAC_INVALID) if the signed request is invalid or expired.
 * @throws AppError(CUSTOMER_NOT_AUTHENTICATED) if customer is not logged in.
 */
export function authenticateAppProxyRequest(request: Request): AppProxyContext {
  const url = new URL(request.url);
  verifyAppProxyHmac(url.searchParams);
  const params = Object.fromEntries(url.searchParams.entries());

  const rawCustomerId = params["logged_in_customer_id"];
  const shop = params["shop"] ?? "";
  const pathPrefix = params["path_prefix"] ?? "";

  const configuredShop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!configuredShop) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is required to authenticate App Proxy requests.");
  }

  let normalizedSignedShop: string;
  try {
    normalizedSignedShop = normalizeShopifyShopDomain(shop);
  } catch {
    throw new AppError(ErrorCode.HMAC_INVALID, "App Proxy request contains an invalid shop");
  }

  if (normalizedSignedShop !== normalizeShopifyShopDomain(configuredShop)) {
    throw new AppError(ErrorCode.HMAC_INVALID, "App Proxy request shop does not match this app");
  }

  if (!rawCustomerId || rawCustomerId === "0" || rawCustomerId === "") {
    throw new AppError(
      ErrorCode.CUSTOMER_NOT_AUTHENTICATED,
      "Customer is not logged in. App Proxy request missing logged_in_customer_id."
    );
  }

  // Normalize to Shopify GID format if not already in GID form
  const customerId = rawCustomerId.startsWith("gid://")
    ? rawCustomerId
    : `gid://shopify/Customer/${rawCustomerId}`;

  return { customer_id: customerId, shop: normalizedSignedShop, path_prefix: pathPrefix };
}

/**
 * Parses query parameters from a request URL into a plain object.
 * Convenience helper for passing to verifyAppProxyHmac().
 *
 * @param request - The incoming request.
 * @returns Record of all query parameters as strings.
 */
