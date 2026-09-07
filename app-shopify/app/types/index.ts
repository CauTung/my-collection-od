/**
 * app/types/index.ts
 *
 * Centralizes all TypeScript types and interfaces for the entire project.
 * Do not redefine types with the same name in multiple places — if a new type is needed,
 * add it here, then import from "~/types".
 */

// ─── Shopify GraphQL ID Types ─────────────────────────────────────────────────
/** GID format Shopify uses for all resource IDs. */
export type ShopifyGid = `gid://shopify/${string}/${string}`;

// ─── Collection Item ──────────────────────────────────────────────────────────
/** Origin of the collection item — used for audit/ERP-ready integration. */
export type CollectionItemSource = "shopify_sync" | "erp_sync" | "manual_entry";

/**
 * Represents 1 coin/item in the collector's collection.
 *
 * Note: customer_id MUST be retained when mapping from Metaobject raw data
 * to defense-in-depth verify data isolation at the application layer
 * (required to prevent cross-customer data leakage).
 */
export interface CollectionItem {
  /** UUID v4, immutable — created when the item is first added. */
  item_id: string;
  /** Customer GID — MUST be retained, used to verify data isolation. */
  customer_id: string;
  /** Shopify product GID. */
  product_id: string;
  /** SKU for ERP mapping (not used in MVP). */
  sku_code?: string;
  /** Item source. */
  source: CollectionItemSource;
  /** Shopify order GID — used for dedup. Null if manual_entry. */
  external_order_id?: string;
  /** Quantity owned. Min 1, max MAX_QUANTITY_OWNED. */
  quantity_owned: number;
  /** Date the item was added to the collection (auto-set). */
  date_added_to_collection: string;
  /** Purchase date (can be order date). */
  purchase_date?: string;
  /** Purchase price (AUD). */
  purchase_price?: number;
  /**
   * Current market value (AUD) — entered by the collector.
   * NOT automated market price/API. See PROJECT-CONTEXT.md section 7.2.
   */
  current_market_value?: number;
  /** Certificate number (PCGS/NGC/etc). Max MAX_CERTIFICATE_NUMBER_LENGTH chars. */
  certificate_number?: string;
  /** Grade recorded by the collector. Max MAX_USER_GRADE_LENGTH chars. */
  user_grade?: string;
  /** Personal notes. Max MAX_USER_NOTES_LENGTH chars. */
  user_notes?: string;
  /** Whether the item is in the wishlist. */
  in_wishlist: boolean;
  /** Soft delete flag. */
  is_deleted: boolean;
}

// ─── Collection Filters & Pagination ─────────────────────────────────────────
/** Filters for the collection list — state is retained via URL params. */
export interface CollectionFilters {
  denomination?: string;
  country_of_issue?: string;
  material?: string;
  year_of_issue?: string;
  grade?: string;
  issuer?: string;
  in_wishlist?: boolean;
  /** Cursor for the next page (cursor-based pagination). */
  after?: string;
  /** Number of items per page — defaults to COLLECTION_PAGE_SIZE. */
  first?: number;
}

/** Paginated result of the collection list. */
export interface CollectionPage {
  items: CollectionItem[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor?: string;
    endCursor?: string;
  };
  totalItems: number;
  totalValue: number;
}

// ─── Customer Stats (cached Metafields) ──────────────────────────────────────
/** Stats cached in Customer Metafields — fast read without scanning. */
export interface CollectionStats {
  total_items: number;
  total_value: number;
  created_at?: string;
  last_updated?: string;
}

// ─── Shopify Webhook Payloads ─────────────────────────────────────────────────
/** Line item in Shopify order webhook. */
export interface ShopifyLineItem {
  id: number;
  product_id: number | null;
  variant_id: number | null;
  title: string;
  quantity: number;
  price: string;
  sku: string | null;
  vendor: string | null;
  product_type: string;
  properties: Array<{ name: string; value: string }>;
}

/** Payload of orders/paid webhook. */
export interface ShopifyOrderPaidPayload {
  id: number;
  order_number: number;
  created_at: string;
  financial_status: string;
  customer: {
    id: number;
  };
  line_items: ShopifyLineItem[];
}

/** Payload of orders/cancelled webhook. */
export interface ShopifyOrderCancelledPayload {
  id: number;
  order_number: number;
  cancel_reason: string | null;
  cancelled_at: string;
  customer: {
    id: number;
  };
  line_items: ShopifyLineItem[];
  refunds: Array<{
    refund_line_items: Array<{
      line_item_id: number;
      quantity: number;
      line_item: ShopifyLineItem;
    }>;
  }>;
}

/** Payload of refunds/create webhook. */
export interface ShopifyRefundPayload {
  id: number;
  order_id: number;
  created_at: string;
  refund_line_items: Array<{
    id: number;
    quantity: number;
    line_item_id: number;
    line_item: ShopifyLineItem;
  }>;
}

// ─── App Proxy Request ────────────────────────────────────────────────────────
/** Data parsed from App Proxy request after HMAC verification + session extraction. */
export interface AppProxyContext {
  customer_id: string;
  shop: string;
  path_prefix: string;
}

// ─── Error Handling ───────────────────────────────────────────────────────────
/**
 * Specific business error codes — used with AppError class.
 * Unexpected infrastructure errors (network, parse fail) do not need an ErrorCode,
 * they propagate naturally to the generic withErrorHandler catch block.
 */
export enum ErrorCode {
  HMAC_INVALID = "HMAC_INVALID",
  WEBHOOK_INVALID_PAYLOAD = "WEBHOOK_INVALID_PAYLOAD",
  CUSTOMER_NOT_AUTHENTICATED = "CUSTOMER_NOT_AUTHENTICATED",
  ITEM_NOT_FOUND = "ITEM_NOT_FOUND",
  ITEM_ACCESS_DENIED = "ITEM_ACCESS_DENIED",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  SYNC_ALREADY_RUNNING = "SYNC_ALREADY_RUNNING",
  SYNC_QUEUED = "SYNC_QUEUED",
  GRAPHQL_ERROR = "GRAPHQL_ERROR",
}

// ─── Batch Sync ───────────────────────────────────────────────────────────────
/** Status of a historical batch sync job. */
export type BatchSyncStatus = "idle" | "syncing" | "queued" | "completed" | "failed";

/** Result returned when triggering batch sync. */
export interface BatchSyncTriggerResult {
  status: BatchSyncStatus;
  message: string;
  /** Only present when status === 'completed' or 'syncing'. */
  progress?: {
    processed: number;
    total: number;
    failed: number;
  };
}

// ─── GraphQL Client ───────────────────────────────────────────────────────────
/** Standard response from Shopify Admin GraphQL API. */
export interface ShopifyGraphQLResponse<T = unknown> {
  data: T | null;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number | null;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

/** UserError from Shopify mutation response. */
export interface ShopifyUserError {
  field: string[] | null;
  message: string;
  code?: string;
}

// ─── Product Metafield ────────────────────────────────────────────────────────
/** Collectible data from Product Metafield — used to classify coin vs accessory. */
export interface CollectibleData {
  erp_sku?: string;
  denomination?: string;
  country_of_issue?: string;
  material?: string;
  year_of_issue?: string;
  issuer?: string;
  quality?: string;
  grade?: string;
  limited_mintage?: boolean;
  mintage_limit?: number;
}

// ─── Wishlist Adapter ─────────────────────────────────────────────────────────
/** Interface for the Wishlist adapter — uses Adapter Pattern to isolate the vendor. */
export interface WishlistAdapter {
  addToWishlist(customerId: string, productId: string): Promise<void>;
  removeFromWishlist(customerId: string, productId: string): Promise<void>;
  isInWishlist(customerId: string, productId: string): Promise<boolean>;
}
