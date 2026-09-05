/**
 * app/config/constants.ts
 *
 * Single source of truth for all limits, thresholds, timeouts, and magic numbers
 * across the entire project. Every module MUST import from here — no hardcoding.
 *
 * Changing values here affects both code and UX copy (sync banner).
 * Modifying boundaries requires updating both frontend copy and backend filters.
 */

// ─── Historical Batch Sync ───────────────────────────────────────────────────
/**
 * Maximum number of years to look back during Historical Batch Sync.
 * Must sync with: GraphQL filter, UX copy banner on FE, and boundary test cases.
 * Modifying this lookback window requires updating all relevant filters and UI copy at once.
 */
export const HISTORICAL_SYNC_LOOKBACK_YEARS = 10;

/**
 * Maximum number of orders fetched in one Historical Batch Sync run.
 * Same constraint as above — must sync everywhere it's mentioned.
 */
export const HISTORICAL_SYNC_MAX_ORDERS = 200;

// ─── Collection Item Constraints ─────────────────────────────────────────────
/** Maximum quantity allowed for a single item in the collection. */
export const MAX_QUANTITY_OWNED = 999;

/** Maximum length for certificate_number (chars). */
export const MAX_CERTIFICATE_NUMBER_LENGTH = 50;

/** Maximum length for user_grade (chars). */
export const MAX_USER_GRADE_LENGTH = 200;

/** Maximum length for user_notes (chars). */
export const MAX_USER_NOTES_LENGTH = 500;

// ─── Loyalty Integration ──────────────────────────────────────────────────────
/** Yotpo points rewarded when collector creates their collection for the first time. */
export const LOYALTY_SIGNUP_BONUS_POINTS = 50;

// ─── App Proxy Rate Limiting ──────────────────────────────────────────────────
/** Request limit per minute per IP for the App Proxy endpoint. */
export const APP_PROXY_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Maximum accepted clock difference for signed App Proxy requests.
 * Limiting signed URL lifetime reduces replay risk while allowing normal clock skew.
 */
export const APP_PROXY_MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

// ─── Shopify Admin GraphQL — Leaky Bucket ─────────────────────────────────────
/** Total leaky bucket capacity (cost points). */
export const GRAPHQL_BUCKET_CAPACITY = 5000;

/** Bucket recovery rate (cost points / second). */
export const GRAPHQL_LEAK_RATE_PER_SECOND = 50;

/**
 * Base delay for exponential backoff when THROTTLED (ms).
 * Formula: GRAPHQL_RETRY_BASE_DELAY_MS * 2^attempt
 */
export const GRAPHQL_RETRY_BASE_DELAY_MS = 500;

/** Maximum retry attempts when THROTTLED/429. */
export const GRAPHQL_MAX_RETRY_ATTEMPTS = 5;

// ─── Batch Sync Concurrency ───────────────────────────────────────────────────
/**
 * Number of concurrent orders processed in a single Batch Sync job per customer.
 * This concurrency measures "parallel orders",
 * not "items within one order".
 */
export const BATCH_SYNC_CONCURRENCY = 5;

/**
 * Maximum global concurrent Batch Sync jobs running system-wide (cross-customer).
 * This is an in-memory instance-level counter (not a distributed lock) — an acceptable
 * trade-off for this serverless architecture.
 */
export const MAX_CONCURRENT_BATCH_SYNC_JOBS = 10;

// ─── Pagination ───────────────────────────────────────────────────────────────
/** Number of items per page in the Collection list (cursor-based pagination). */
export const COLLECTION_PAGE_SIZE = 50;

// ─── Idempotency ─────────────────────────────────────────────────────────────
/**
 * TTL (ms) for idempotency key cache in memory (instance-level).
 * After this TTL, the same key could be processed again — acceptable because
 * double-submits usually happen within seconds, not minutes.
 */
export const IDEMPOTENCY_KEY_TTL_MS = 5 * 60 * 1000; // 5 minutes
