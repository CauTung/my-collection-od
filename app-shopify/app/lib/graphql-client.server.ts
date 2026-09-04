/**
 * app/lib/graphql-client.server.ts
 *
 * The ONLY place in the codebase that calls Shopify Admin GraphQL API.
 * All other modules must call shopifyGraphQL() from here — never call fetch() directly.
 *
 * Design decisions:
 * - Uses SHOPIFY_ADMIN_ACCESS_TOKEN (NOT SHOPIFY_APP_SECRET). These are two entirely
 *   different secrets with different purposes.
 * - Two-layer rate limit protection:
 *   1. REACTIVE: On HTTP 429 or THROTTLED extension, exponential backoff with retry.
 *   2. PROACTIVE: After each response, check currentlyAvailable. If bucket is low
 *      (< actualQueryCost * 2), sleep to let it refill before the next request.
 *      This prevents hitting the wall — we slow down before Shopify rejects us.
 * - For batched alias payloads: cost is cumulative (N × cost/mutation). The cost
 *   calculator must account for this to avoid throttling.
 */

import {
  GRAPHQL_RETRY_BASE_DELAY_MS,
  GRAPHQL_MAX_RETRY_ATTEMPTS,
} from "~/config/constants";
import type { ShopifyGraphQLResponse } from "~/types";
import { logger } from "./logger.server";
import { AppError } from "./error-handler.server";
import { ErrorCode } from "~/types";

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
// Admin access token — ONLY used here, NEVER for HMAC verification
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = "2024-10";

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calculate exponential backoff delay with ±30% jitter. */
function calculateDelay(attempt: number): number {
  const base = GRAPHQL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = base * (Math.random() * 0.6 - 0.3); // ±30%
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Checks if any userError in the response indicates a duplicate handle collision.
 * Used to distinguish expected race-condition errors from real failures.
 */
export function isDuplicateHandleError(userErrors: Array<{ message: string }>): boolean {
  return userErrors.some(
    (e) =>
      e.message.toLowerCase().includes("taken") ||
      e.message.toLowerCase().includes("already")
  );
}

/**
 * Execute a Shopify Admin GraphQL query or mutation with automatic retry and
 * proactive rate limiting.
 *
 * @param query - Named GraphQL operation string. Name it clearly (e.g. "query GetCollectionItems").
 * @param variables - Variables object. ALWAYS use this — never string-interpolate user input.
 * @param attempt - Internal retry counter. Do not pass this from call sites.
 * @throws AppError(GRAPHQL_ERROR) after exhausting all retries.
 * @throws Error if environment variables are missing (startup misconfiguration).
 */
export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  attempt = 0,
  reqId = Math.random().toString(36).substring(2, 9)
): Promise<ShopifyGraphQLResponse<T>> {
  if (!SHOP_DOMAIN || !ADMIN_ACCESS_TOKEN) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN environment variables. " +
        "Check .env.example — these are DIFFERENT from SHOPIFY_APP_SECRET."
    );
  }

  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  const isMutation = query.trim().startsWith("mutation");

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Admin access token header — NOT the app secret
        "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (networkErr) {
    // Network-level failure (DNS, connection refused)
    // Only retry for queries, not mutations, to avoid double-application of lost responses
    if (attempt < GRAPHQL_MAX_RETRY_ATTEMPTS && !isMutation) {
      const delay = calculateDelay(attempt);
      logger.warn("GraphQL network error on query, retrying", { reqId, attempt, delay, error: String(networkErr) });
      await sleep(delay);
      return shopifyGraphQL<T>(query, variables, attempt + 1, reqId);
    }
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `GraphQL network error (attempt ${attempt + 1}, reqId ${reqId}): ${String(networkErr)}`
    );
  }

  // REACTIVE: Shopify returned 429 — back off and retry
  if (response.status === 429) {
    if (attempt >= GRAPHQL_MAX_RETRY_ATTEMPTS) {
      throw new AppError(
        ErrorCode.GRAPHQL_ERROR,
        `Shopify rate limit (429) exceeded after ${GRAPHQL_MAX_RETRY_ATTEMPTS} retries (reqId ${reqId})`
      );
    }
    const delay = calculateDelay(attempt);
    logger.warn("Shopify returned 429, backing off", { reqId, attempt, delay });
    await sleep(delay);
    return shopifyGraphQL<T>(query, variables, attempt + 1, reqId);
  }

  if (!response.ok) {
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `Shopify Admin API HTTP error: ${response.status} ${response.statusText} (reqId ${reqId})`
    );
  }

  const result = (await response.json()) as ShopifyGraphQLResponse<T>;

  // Check for THROTTLED in GraphQL extensions (cost-based throttling, not HTTP 429)
  const isThrottled = result.errors?.some(
    (e) => e.extensions?.["code"] === "THROTTLED"
  );

  if (isThrottled) {
    if (attempt >= GRAPHQL_MAX_RETRY_ATTEMPTS) {
      throw new AppError(
        ErrorCode.GRAPHQL_ERROR,
        `Shopify THROTTLED after ${GRAPHQL_MAX_RETRY_ATTEMPTS} retries (reqId ${reqId})`
      );
    }
    const delay = calculateDelay(attempt);
    logger.warn("Shopify GraphQL THROTTLED, backing off", { reqId, attempt, delay });
    await sleep(delay);
    return shopifyGraphQL<T>(query, variables, attempt + 1, reqId);
  }

  // PROACTIVE: Inspect remaining bucket capacity after a successful response.
  // If available budget is less than 2× the cost of this request, sleep proactively.
  // This prevents the next request from hitting the wall — we decelerate before rejection.
  const cost = result.extensions?.cost;
  if (cost) {
    const { actualQueryCost, throttleStatus } = cost;
    const { currentlyAvailable } = throttleStatus;

    logger.debug("GraphQL cost", {
      actualQueryCost,
      currentlyAvailable,
      maximumAvailable: throttleStatus.maximumAvailable,
    });

    const safetyThreshold = actualQueryCost * 2;
    if (currentlyAvailable < safetyThreshold) {
      if (throttleStatus.restoreRate <= 0) {
        logger.warn("Proactive throttle: restoreRate is 0 or negative, skipping sleep", { reqId, throttleStatus });
      } else {
        // Calculate how long to sleep for the bucket to refill enough
        const deficit = safetyThreshold - currentlyAvailable;
        const sleepMs = Math.ceil((deficit / throttleStatus.restoreRate) * 1000);
        logger.info("Proactive throttle: sleeping to let bucket refill", {
          reqId,
          currentlyAvailable,
          safetyThreshold,
          sleepMs,
        });
        await sleep(sleepMs);
      }
    }
  }

  // Check for top-level GraphQL errors (execution failures, permission issues, etc)
  if (result.errors && result.errors.length > 0 && !isThrottled) {
    logger.error("GraphQL response contained errors", {
      reqId,
      errors: result.errors.map((e) => ({ message: e.message, path: e.path })),
    });
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `GraphQL execution errors (reqId ${reqId}): ${result.errors.map((e) => e.message).join(", ")}`
    );
  }

  return result;
}
