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
 * - This module does NOT verify HMAC — that must be done first in the route handler.
 */

import { AppError } from "./error-handler.server";
import { ErrorCode } from "~/types";
import type { AppProxyContext } from "~/types";

/**
 * Extracts App Proxy context (customer_id, shop, path_prefix) from an incoming request.
 *
 * @param request - The incoming Remix Request object from an App Proxy route.
 * @returns AppProxyContext with normalized customer GID.
 * @throws AppError(CUSTOMER_NOT_AUTHENTICATED) if customer is not logged in.
 */
export function extractAppProxySession(request: Request): AppProxyContext {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const rawCustomerId = params["logged_in_customer_id"];
  const shop = params["shop"] ?? "";
  const pathPrefix = params["path_prefix"] ?? "";

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

  return { customer_id: customerId, shop, path_prefix: pathPrefix };
}

/**
 * Parses query parameters from a request URL into a plain object.
 * Convenience helper for passing to verifyAppProxyHmac().
 *
 * @param request - The incoming request.
 * @returns Record of all query parameters as strings.
 */
export function getQueryParams(request: Request): Record<string, string> {
  const url = new URL(request.url);
  return Object.fromEntries(url.searchParams.entries());
}
