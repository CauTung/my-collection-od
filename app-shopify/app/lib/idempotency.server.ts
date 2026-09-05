/**
 * app/lib/idempotency.server.ts
 *
 * In-process idempotency key cache for manual CRUD routes (POST/PUT collection items).
 *
 * Design decisions:
 * - Protects manual Add/Edit routes against double-submit caused by slow network or
 *   accidental double-click. This is separate from the webhook dedup in dedup.server.ts
 *   which handles server-to-server race conditions.
 * - Uses an in-memory Map with TTL timestamps (not Redis) — acceptable trade-off since double-submits happen within seconds, well within the TTL window.
 * - Cache identity includes customer, operation, resource, and client key. A client key
 *   can therefore never return another customer's cached response.
 * - In serverless environments with multiple instances, the same idempotency_key could
 *   be processed once per instance. The client-side disable-on-submit (FE layer) is the
 *   primary guard; this cache is the secondary server-side guard per instance.
 * - TTL is controlled by IDEMPOTENCY_KEY_TTL_MS in constants.ts.
 */

import { IDEMPOTENCY_KEY_TTL_MS } from "~/config/constants";
import { logger } from "./logger.server";

interface CacheEntry<T> {
  result: T | "processing";
  expiresAt: number;
}

// In-memory store: customer + operation + resource + idempotency_key → cached result
// Generic over the result type so the cache works for any CRUD operation
const cache = new Map<string, CacheEntry<unknown>>();

export interface IdempotencyScope {
  customerId: string;
  operation: "create" | "update";
  resourceId?: string;
}

/** Periodically purge expired entries to prevent unbounded memory growth. */
function purgeExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

// Run purge every minute — low overhead since the cache is small
setInterval(purgeExpired, 60_000).unref();

type IdempotencyStatus<T> =
  | { status: "claimed" }
  | { status: "processing" }
  | { status: "finished"; result: T };

/**
 * Atomically check and claim an idempotency key.
 *
 * @param scope - Authenticated customer and mutation resource scope.
 * @param key - The idempotency_key UUID from the request body.
 * @returns An object indicating the status of the claim.
 */
export function checkAndClaimIdempotencyKey<T>(
  scope: IdempotencyScope,
  key: string
): IdempotencyStatus<T> {
  const cacheKey = buildScopedCacheKey(scope, key);
  const entry = cache.get(cacheKey) as CacheEntry<T> | undefined;

  if (!entry || Date.now() > entry.expiresAt) {
    // New or expired, claim it by setting to processing immediately
    cache.set(cacheKey, { result: "processing", expiresAt: Date.now() + IDEMPOTENCY_KEY_TTL_MS });
    return { status: "claimed" };
  }

  if (entry.result === "processing") {
    logger.info("Idempotency cache hit — request is currently processing", { key });
    return { status: "processing" };
  }

  logger.info("Idempotency cache hit — returning cached result", { key });
  return { status: "finished", result: entry.result };
}

/**
 * Store the result of a successfully processed request.
 * Subsequent calls with the same key will receive this result.
 *
 * @param scope - Authenticated customer and mutation resource scope.
 * @param key - The idempotency_key UUID from the request body.
 * @param result - The result to cache and return for duplicate requests.
 */
export function setIdempotentResult<T>(scope: IdempotencyScope, key: string, result: T): void {
  const cacheKey = buildScopedCacheKey(scope, key);
  cache.set(cacheKey, {
    result,
    expiresAt: Date.now() + IDEMPOTENCY_KEY_TTL_MS,
  });
  logger.debug("Idempotency result cached", { key, ttlMs: IDEMPOTENCY_KEY_TTL_MS });
}

function buildScopedCacheKey(scope: IdempotencyScope, key: string): string {
  return JSON.stringify([
    scope.customerId,
    scope.operation,
    scope.resourceId ?? "",
    key,
  ]);
}

/**
 * Clear the entire cache. Only for use in tests.
 * Must NOT be called in production code.
 */
export function clearIdempotencyCache(): void {
  cache.clear();
}

/** Return current cache size — for testing and monitoring only. */
export function getIdempotencyCacheSize(): number {
  return cache.size;
}
