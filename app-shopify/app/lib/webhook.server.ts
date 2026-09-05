/**
 * Authenticates and parses Shopify HTTPS webhook deliveries.
 *
 * The raw request bytes are verified before JSON parsing. Signed shop and topic headers
 * are then bound to the configured single-shop runtime and the route's expected topic.
 */

import { AppError } from "./error-handler.server";
import { verifyWebhookHmac } from "./hmac.server";
import { normalizeShopifyShopDomain } from "./shopify-domain.server";
import { ErrorCode } from "~/types";

/**
 * Verify and parse one Shopify webhook delivery.
 *
 * @param request - Incoming Shopify HTTPS webhook request.
 * @param expectedTopic - Exact topic handled by the current route.
 * @returns Parsed JSON payload after HMAC, shop, and topic validation.
 * @throws AppError(HMAC_INVALID) for invalid delivery identity.
 * @throws AppError(WEBHOOK_INVALID_PAYLOAD) for malformed JSON.
 */
export async function authenticateWebhookRequest<T>(
  request: Request,
  expectedTopic: string
): Promise<T> {
  const rawBody = Buffer.from(await request.arrayBuffer());
  verifyWebhookHmac(rawBody, request.headers.get("x-shopify-hmac-sha256"));

  const configuredShop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!configuredShop) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is required to authenticate webhooks.");
  }

  const signedShop = request.headers.get("x-shopify-shop-domain");
  if (!signedShop) {
    throw new AppError(ErrorCode.HMAC_INVALID, "Missing Shopify webhook shop header");
  }

  let normalizedSignedShop: string;
  try {
    normalizedSignedShop = normalizeShopifyShopDomain(signedShop);
  } catch {
    throw new AppError(ErrorCode.HMAC_INVALID, "Invalid Shopify webhook shop header");
  }

  if (normalizedSignedShop !== normalizeShopifyShopDomain(configuredShop)) {
    throw new AppError(ErrorCode.HMAC_INVALID, "Webhook shop does not match this app");
  }

  if (request.headers.get("x-shopify-topic") !== expectedTopic) {
    throw new AppError(ErrorCode.HMAC_INVALID, "Webhook topic does not match this route");
  }

  try {
    const payload: unknown = JSON.parse(rawBody.toString("utf-8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Webhook JSON root must be an object");
    }
    return payload as T;
  } catch {
    throw new AppError(ErrorCode.WEBHOOK_INVALID_PAYLOAD, "Invalid Shopify webhook JSON payload");
  }
}
