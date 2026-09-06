/**
 * app/lib/dedup.server.ts
 *
 * Atomic order deduplication engine for webhook and batch sync processing.
 *
 * Design decisions:
 * - Uses a dedicated Metaobject type "collection_dedup_lock" (separate from collection_item)
 *   so the lock type doesn't pollute the data type. See tech-lead-spec.md section 3.2.
 * - Atomicity strategy: call metaobjectCreate with a normalized handle, then catch the
 *   "taken" / "already" userError to detect duplicates. Do NOT use metaobjectByHandle
 *   first — that creates a check-then-act race condition between the read and the write.
 *   database, making it truly atomic.
 * - Handle format: "dedup-{customerId_numeric}-{orderId_numeric}" using numeric IDs
 *   extracted from GIDs because raw GIDs contain `/` and `:` which are invalid in
 *   Shopify metaobject handles.
 */

import { shopifyGraphQL, isDuplicateHandleError } from "./graphql-client.server";
import { logger } from "./logger.server";
import { AppError } from "./error-handler.server";
import { ErrorCode } from "~/types";
import { buildMetaobjectFieldFilter } from "./metaobject-search.server";
import { extractShopifyIdSegment } from "./shopify-id.server";
import {
  COLLECTION_DEDUP_LOCK_METAOBJECT_TYPE,
  METAOBJECT_MAX_PAGE_SIZE,
} from "~/config/constants";

/**
 * Extract the numeric part from a Shopify GID.
 * Example: "gid://shopify/Customer/12345" → "12345"
 */
/**
 * Build the normalized dedup lock handle for an order.
 * Format: "dedup-{customerId}-{orderId}" using numeric IDs.
 */
function buildDedupHandle(customerId: string, orderId: string): string {
  return `dedup-${extractShopifyIdSegment(customerId)}-${extractShopifyIdSegment(orderId)}`;
}

/**
 * Atomically claim an order for processing. Returns true if this call successfully
 * claimed the order (first time processing), false if already claimed (duplicate).
 *
 * This is the ONLY correct way to check for duplicate orders. Any check-then-create
 * approach introduces a race condition window between the read and the write.
 *
 * @param customerId - Shopify Customer GID (e.g. "gid://shopify/Customer/123").
 * @param orderId - Shopify Order GID (e.g. "gid://shopify/Order/456").
 * @returns true if the order was claimed (process it), false if already claimed (skip).
 */
export async function claimOrderSync(customerId: string, orderId: string): Promise<boolean> {
  const handle = buildDedupHandle(customerId, orderId);

  const result = await shopifyGraphQL<{
    metaobjectCreate: {
      metaobject: { id: string } | null;
      userErrors: Array<{ message: string; field: string[] | null }>;
    };
  }>(
    // Named operation — required for test mocking and log tracing
    `mutation ClaimOrderSync($input: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $input) {
        metaobject {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      input: {
        type: COLLECTION_DEDUP_LOCK_METAOBJECT_TYPE,
        handle,
        fields: [
          { key: "customer_id", value: customerId },
          { key: "external_order_id", value: orderId },
        ],
      },
    }
  );

  const { userErrors, metaobject } = result.data?.metaobjectCreate ?? {
    userErrors: [],
    metaobject: null,
  };

  if (userErrors.length > 0) {
    // Check if the error is a duplicate handle collision — this is the expected
    // happy path for dedup: a second attempt on the same order hits the uniqueness constraint.
    const isDuplicate = isDuplicateHandleError(userErrors);

    if (isDuplicate) {
      // Swallow this error — it means the order was already processed. Not a failure.
      logger.warn("Dedup: order already claimed, skipping", {
        handle,
        customerId,
        orderId,
      });
      return false;
    }

    // A different userError (unexpected)
    logger.error("Dedup: unexpected userError during claimOrderSync", {
      handle,
      userErrors,
    });
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Unexpected error during dedup claim");
  }

  if (!metaobject) {
    logger.error("Dedup: metaobjectCreate returned no metaobject and no userErrors", { handle });
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "No metaobject created during dedup claim");
  }

  logger.info("Dedup: order claimed successfully", { handle, customerId, orderId });
  return true;
}

/**
 * Check an event claim by its canonical handle without scanning dedup metaobjects.
 * Used to prevent a late orders/paid delivery from recreating a cancelled order.
 */
export async function isOrderSyncClaimed(customerId: string, orderId: string): Promise<boolean> {
  const handle = buildDedupHandle(customerId, orderId);
  const result = await shopifyGraphQL<{
    metaobjectByHandle?: { id: string } | null;
  }>(
    `query GetOrderSyncClaim($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id }
    }`,
    {
      handle: {
        type: COLLECTION_DEDUP_LOCK_METAOBJECT_TYPE,
        handle,
      },
    }
  );

  if (!result.data || !("metaobjectByHandle" in result.data)) {
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not return the dedup lookup payload");
  }

  return Boolean(result.data.metaobjectByHandle);
}

/**
 * List one page of customer-owned event claims for permanent privacy deletion.
 * The application-side customer check provides defense in depth for Shopify search results.
 */
export async function listDedupLocksForPrivacyDeletion(customerId: string): Promise<string[]> {
  const result = await shopifyGraphQL<{
    metaobjects?: {
      nodes?: Array<{
        id: string;
        fields?: Array<{ key: string; value: string }>;
      }>;
    };
  }>(
    `query ListDedupLocksForPrivacyDeletion($query: String!, $first: Int!) {
      metaobjects(type: "${COLLECTION_DEDUP_LOCK_METAOBJECT_TYPE}", first: $first, query: $query) {
        nodes {
          id
          fields { key value }
        }
      }
    }`,
    {
      query: buildMetaobjectFieldFilter("customer_id", customerId),
      first: METAOBJECT_MAX_PAGE_SIZE,
    }
  );

  const metaobjects = result.data?.metaobjects;
  if (!metaobjects) {
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not return privacy deletion claims");
  }

  return (metaobjects.nodes ?? [])
    .filter((node) => node.fields?.some(
      (field) => field.key === "customer_id" && field.value === customerId
    ))
    .map((node) => node.id);
}
