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
  GRAPHQL_PROACTIVE_SAFETY_MULTIPLIER,
  GRAPHQL_RETRY_JITTER_RATIO,
  SHOPIFY_ADMIN_API_VERSION,
} from "~/config/constants";
import type { ShopifyGraphQLResponse } from "~/types";
import { logger } from "./logger.server";
import { AppError } from "./error-handler.server";
import { normalizeShopifyShopDomain } from "./shopify-domain.server";
import { ErrorCode } from "~/types";

interface ShopifyAdminConfig {
  shopDomain: string;
  accessToken: string;
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calculate exponential backoff delay with bounded proportional jitter. */
function calculateDelay(attempt: number): number {
  const base = GRAPHQL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitterRange = GRAPHQL_RETRY_JITTER_RATIO * 2;
  const jitter = base * (Math.random() * jitterRange - GRAPHQL_RETRY_JITTER_RATIO);
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
 * @throws AppError(GRAPHQL_ERROR) after exhausting all retries.
 * @throws Error if environment variables are missing (startup misconfiguration).
 */
export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<ShopifyGraphQLResponse<T>> {
  const config = getShopifyAdminConfig();
  const reqId = Math.random().toString(36).substring(2, 9);
  return executeShopifyGraphQL<T>(query, variables, config, 0, reqId);
}

async function executeShopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  config: ShopifyAdminConfig,
  attempt: number,
  reqId: string
): Promise<ShopifyGraphQLResponse<T>> {
  const url = `https://${config.shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const isMutation = /^\s*mutation\b/.test(query);

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Admin access token — NOT the app secret
        "X-Shopify-Access-Token": config.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (networkErr) {
    // A lost mutation response has an unknown commit state, so only queries are retried.
    if (attempt < GRAPHQL_MAX_RETRY_ATTEMPTS && !isMutation) {
      const delay = calculateDelay(attempt);
      logger.warn("GraphQL network error on query, retrying", { reqId, attempt, delay, error: String(networkErr) });
      await sleep(delay);
      return executeShopifyGraphQL<T>(query, variables, config, attempt + 1, reqId);
    }
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `GraphQL network error (attempt ${attempt + 1}, reqId ${reqId}): ${String(networkErr)}`
    );
  }

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
    return executeShopifyGraphQL<T>(query, variables, config, attempt + 1, reqId);
  }

  if (!response.ok) {
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `Shopify Admin API HTTP error: ${response.status} ${response.statusText} (reqId ${reqId})`
    );
  }

  let result: ShopifyGraphQLResponse<T>;
  try {
    result = (await response.json()) as ShopifyGraphQLResponse<T>;
  } catch (error) {
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `Shopify Admin API returned invalid JSON (reqId ${reqId}): ${String(error)}`
    );
  }

  const isThrottled = result.errors?.some(
    (error) => error.extensions?.["code"] === "THROTTLED"
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
    return executeShopifyGraphQL<T>(query, variables, config, attempt + 1, reqId);
  }

  if (result.errors && result.errors.length > 0) {
    logger.error("GraphQL response contained errors", {
      reqId,
      errors: result.errors.map((error) => ({ message: error.message, path: error.path })),
    });
    throw new AppError(
      ErrorCode.GRAPHQL_ERROR,
      `GraphQL execution errors (reqId ${reqId}): ${result.errors.map((error) => error.message).join(", ")}`
    );
  }

  const cost = result.extensions?.cost;
  if (cost) {
    const { actualQueryCost, throttleStatus } = cost;
    const { currentlyAvailable } = throttleStatus;

    logger.debug("GraphQL cost", {
      actualQueryCost,
      currentlyAvailable,
      maximumAvailable: throttleStatus.maximumAvailable,
    });

    // Shopify reports actual cost for the whole alias document, so an N-alias
    // request is naturally accounted for by the cumulative response cost.
    const safetyThreshold = actualQueryCost * GRAPHQL_PROACTIVE_SAFETY_MULTIPLIER;
    if (currentlyAvailable < safetyThreshold) {
      if (throttleStatus.restoreRate <= 0) {
        logger.warn("Proactive throttle: restoreRate is 0 or negative, skipping sleep", { reqId, throttleStatus });
      } else {
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

  return result;
}

function getShopifyAdminConfig(): ShopifyAdminConfig {
  const shopDomainValue = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shopDomainValue || !accessToken) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN environment variables. " +
        "Check .env.example — these are DIFFERENT from SHOPIFY_APP_SECRET."
    );
  }
  return {
    shopDomain: normalizeShopifyShopDomain(shopDomainValue),
    accessToken,
  };
}
