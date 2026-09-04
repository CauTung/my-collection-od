/**
 * app/lib/hmac.server.ts
 *
 * HMAC-SHA256 verification for Shopify App Proxy requests and Webhook deliveries.
 *
 * Design decisions:
 * - Uses SHOPIFY_APP_SECRET exclusively — NOT SHOPIFY_ADMIN_ACCESS_TOKEN.
 *   These are different secrets for different purposes.
 * - Two distinct verification modes because Shopify uses different signing strategies:
 *   1. APP_PROXY: Signs the sorted query parameter string (without "signature" key).
 *   2. WEBHOOK: Signs the raw request body (Buffer), reads HMAC from header.
 * - Uses timingSafeEqual for comparison to prevent timing-based HMAC oracle attacks.
 * - Throws AppError(HMAC_INVALID) on failure — caught by withErrorHandler in routes.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { AppError } from "./error-handler.server";
import { ErrorCode } from "~/types";


function getAppSecret(): string {
  // Read lazily — not at module load time — so tests can inject via process.env
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) {
    throw new Error(
      "SHOPIFY_APP_SECRET is not set. This is the App Proxy / Webhook signing secret, " +
        "NOT the Admin access token. Check .env.example."
    );
  }
  return secret;
}

/**
 * Verify HMAC for a Shopify App Proxy request.
 *
 * Shopify signs App Proxy requests by:
 * 1. Taking all query parameters except "signature".
 * 2. Sorting them alphabetically by key.
 * 3. Joining as "key=value" pairs with "&".
 * 4. Computing HMAC-SHA256 with the App Secret.
 *
 * @param queryParams - The parsed query parameters from the incoming request URL.
 * @throws AppError(HMAC_INVALID) if verification fails.
 */
export function verifyAppProxyHmac(queryParams: Record<string, string>): void {
  const secret = getAppSecret();
  const incomingSignature = queryParams["signature"];

  if (!incomingSignature) {
    throw new AppError(ErrorCode.HMAC_INVALID, "Missing signature parameter in App Proxy request");
  }

  // Build the message: sort all params except "signature", join as key=value
  const message = Object.keys(queryParams)
    .filter((key) => key !== "signature")
    .sort()
    .map((key) => `${key}=${queryParams[key]}`)
    .join("&");

  const computed = createHmac("sha256", secret).update(message).digest("hex");

  // timingSafeEqual prevents timing attacks that could reveal partial HMAC matches
  const computedBuffer = Buffer.from(computed, "hex");
  const incomingBuffer = Buffer.from(incomingSignature, "hex");

  if (
    computedBuffer.length !== incomingBuffer.length ||
    !timingSafeEqual(computedBuffer, incomingBuffer)
  ) {
    throw new AppError(ErrorCode.HMAC_INVALID, "App Proxy HMAC verification failed");
  }
}

/**
 * Verify HMAC for a Shopify Webhook delivery.
 *
 * Shopify signs Webhook payloads by:
 * 1. Computing HMAC-SHA256 of the raw request body (as bytes).
 * 2. Encoding the result as base64.
 * 3. Sending it in the "x-shopify-hmac-sha256" header.
 *
 * IMPORTANT: The body must be read as a Buffer (raw bytes), NOT as parsed JSON.
 * Parsing and re-stringifying can change whitespace and break the signature.
 *
 * @param rawBody - Raw request body as a Buffer (read before any JSON.parse).
 * @param hmacHeader - Value of the "x-shopify-hmac-sha256" header.
 * @throws AppError(HMAC_INVALID) if verification fails.
 */
export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string | null): void {
  const secret = getAppSecret();

  if (!hmacHeader) {
    throw new AppError(ErrorCode.HMAC_INVALID, "Missing x-shopify-hmac-sha256 header");
  }

  const computed = createHmac("sha256", secret).update(rawBody).digest("base64");

  // timingSafeEqual requires equal-length buffers
  const computedBuffer = Buffer.from(computed, "base64");
  const incomingBuffer = Buffer.from(hmacHeader, "base64");

  if (
    computedBuffer.length !== incomingBuffer.length ||
    !timingSafeEqual(computedBuffer, incomingBuffer)
  ) {
    throw new AppError(ErrorCode.HMAC_INVALID, "Webhook HMAC verification failed");
  }
}
