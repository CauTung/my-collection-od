/**
 * app/lib/metaobject.server.ts
 *
 * CRUD operations for the collection_item metaobject.
 *
 * Design decisions:
 * - Handle format is strict: {customer_id}-{item_id} where customer_id is numeric.
 *   This gives O(1) lookup by handle for manual CRUD.
 * - upsertCollectionItemByProduct(): Handles Webhook/Batch Sync logic. MUST upsert
 *   by product_id to increment quantity if the user buys the same coin twice, rather
 *   than creating duplicate records.
 * - Customer data isolation: Filter by customer_id in GraphQL queries.
 * - Soft delete: We set is_deleted=true instead of hard deleting to preserve history.
 */

import { v4 as uuidv4 } from "uuid";
import { shopifyGraphQL } from "./graphql-client.server";
import { AppError } from "./error-handler.server";
import { ErrorCode, type CollectionItem, type CollectionFilters, type CollectionPage } from "~/types";
import { logger } from "./logger.server";
import { buildMetaobjectFieldFilter } from "./metaobject-search.server";
import { extractShopifyNumericId } from "./shopify-id.server";
import {
  COLLECTION_ITEM_METAOBJECT_TYPE,
  COLLECTION_PAGE_SIZE,
  MAX_QUANTITY_OWNED,
  METAOBJECT_MAX_PAGE_SIZE,
} from "~/config/constants";

const productUpsertTails = new Map<string, Promise<void>>();

/** Helper to extract numeric ID from a GID. */
/** Helper to build the O(1) lookup handle. */
function buildItemHandle(customerId: string, itemId: string): string {
  return `${extractShopifyNumericId(customerId)}-${itemId}`;
}

/** Helper to map raw Shopify Metaobject to CollectionItem interface. */
function mapMetaobjectToItem(raw: { fields?: Array<{ key: string; value: string }> }): CollectionItem {
  const fields = raw.fields || [];
  const getField = (key: string) => fields.find((f) => f.key === key)?.value;

  return {
    item_id: getField("item_id") || "",
    customer_id: getField("customer_id") || "",
    product_id: getField("product_id") || "",
    sku_code: getField("sku_code"),
    source: (getField("source") as CollectionItem["source"]) || "manual_entry",
    external_order_id: getField("external_order_id"),
    quantity_owned: parseInt(getField("quantity_owned") || "1", 10),
    date_added_to_collection: getField("date_added_to_collection") || "",
    purchase_date: getField("purchase_date"),
    purchase_price: getField("purchase_price") ? parseFloat(getField("purchase_price") as string) : undefined,
    current_market_value: getField("current_market_value") ? parseFloat(getField("current_market_value") as string) : undefined,
    certificate_number: getField("certificate_number"),
    user_grade: getField("user_grade"),
    user_notes: getField("user_notes"),
    in_wishlist: getField("in_wishlist") === "true",
    is_deleted: getField("is_deleted") === "true",
  };
}

/** Helper to format variables for metaobject mutations. */
function formatFields(item: Partial<CollectionItem>) {
  const fields = [];
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || key === "item_id") continue; // item_id is immutable after creation

    let stringValue = "";
    if (typeof value === "boolean") {
      stringValue = value ? "true" : "false";
    } else if (typeof value === "number") {
      stringValue = value.toString();
    } else if (value !== null) {
      stringValue = String(value);
    }

    if (stringValue !== "") {
      fields.push({ key, value: stringValue });
    }
  }
  return fields;
}

// ─── Webhook & Batch Sync Methods ───────────────────────────────────────────

/**
 * Internal helper to find an existing item by product_id.
 */
async function findExistingItemByProduct(customerId: string, productId: string) {
  const queryStr = [
    buildMetaobjectFieldFilter("customer_id", customerId),
    buildMetaobjectFieldFilter("product_id", productId),
    buildMetaobjectFieldFilter("is_deleted", "false"),
  ].join(" AND ");
  const searchResult = await shopifyGraphQL<{
    metaobjects?: {
      nodes?: Array<{ id: string; fields?: Array<{ key: string; value: string }> }>;
    };
  }>(
    `query FindExistingItem($query: String!) {
      metaobjects(type: "${COLLECTION_ITEM_METAOBJECT_TYPE}", first: 1, query: $query) {
        nodes {
          id
          fields { key value }
        }
      }
    }`,
    { query: queryStr }
  );

  const metaobjects = searchResult.data?.metaobjects;
  if (!metaobjects) {
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not return the item search payload");
  }

  if (!metaobjects.nodes?.length) {
    return null;
  }

  const node = metaobjects.nodes[0];
  return {
    id: node.id,
    item: mapMetaobjectToItem(node),
  };
}

/**
 * Finds a collection item by product ID for a specific customer.
 * Useful for cancellation and refund webhooks where we need to decrement quantity.
 */
export async function findCollectionItemByProduct(customerId: string, productId: string) {
  return findExistingItemByProduct(customerId, productId);
}

/**
 * Manually creates a new collection item (e.g. from UI).
 */
export async function createCollectionItem(
  customerId: string,
  data: Partial<CollectionItem>
): Promise<CollectionItem> {
  // Generate a random item_id since it's a new entry
  const itemId = `item_${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`;
  
  const newItem = {
    ...data,
    item_id: itemId,
    customer_id: customerId,
    source: "manual_entry" as const,
    quantity_owned: data.quantity_owned ?? 1,
    is_deleted: false,
    date_added_to_collection: new Date().toISOString().split("T")[0],
  };

  assertValidQuantity(newItem.quantity_owned);
  const handle = buildItemHandle(customerId, itemId);

  interface CreateResponse {
    metaobjectCreate?: {
      metaobject?: { id: string };
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const result = await shopifyGraphQL<CreateResponse>(
    `mutation CreateCollectionItem($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    {
      metaobject: {
        type: COLLECTION_ITEM_METAOBJECT_TYPE,
        handle,
        fields: [{ key: "item_id", value: itemId }, ...formatFields(newItem)],
      },
    }
  );

  const errors = result.data?.metaobjectCreate?.userErrors || [];
  if (errors.length > 0) {
    logger.error("Failed to create manual item metaobject", { errors, customerId, itemId });
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Failed to create item");
  }

  if (!result.data?.metaobjectCreate?.metaobject) {
    logger.error("Manual item creation returned no metaobject and no userErrors", {
      customerId,
      itemId,
    });
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not create the collection item");
  }

  return newItem as CollectionItem;
}

/**
 * Upsert an item by product_id.
 * If the customer already owns this product, increment quantity_owned.
 * If not, create a new record.
 * This addresses the requirement to increment rather than create duplicate coins.
 */
export async function upsertCollectionItemByProduct(
  customerId: string,
  productId: string,
  additionalData: Partial<CollectionItem>
): Promise<void> {
  const additionalQuantity = additionalData.quantity_owned ?? 1;
  assertValidQuantity(additionalQuantity);
  const lockKey = `${customerId}:${productId}`;
  await runWithProductUpsertLock(lockKey, () =>
    upsertCollectionItemByProductUnlocked(
      customerId,
      productId,
      additionalData,
      additionalQuantity
    )
  );
}

/**
 * Decrement one customer/product quantity for cancellation and refund webhooks.
 * Same-instance operations share the product lock with upserts to avoid lost updates.
 */
export async function decrementCollectionItemByProduct(
  customerId: string,
  productId: string,
  decrementQuantity: number
): Promise<void> {
  assertValidQuantity(decrementQuantity);
  const lockKey = `${customerId}:${productId}`;
  await runWithProductUpsertLock(lockKey, async () => {
    const existing = await findExistingItemByProduct(customerId, productId);
    if (!existing) {
      return;
    }

    const newQuantity = existing.item.quantity_owned - decrementQuantity;
    if (newQuantity <= 0) {
      await updateCollectionItemRaw(existing.id, { is_deleted: true });
      return;
    }

    assertValidQuantity(newQuantity);
    await updateCollectionItemRaw(existing.id, { quantity_owned: newQuantity });
  });
}

async function upsertCollectionItemByProductUnlocked(
  customerId: string,
  productId: string,
  additionalData: Partial<CollectionItem>,
  additionalQuantity: number
): Promise<void> {
  const existing = await findExistingItemByProduct(customerId, productId);

  if (existing) {
    // UPDATE existing (increment quantity)
    const newQuantity = existing.item.quantity_owned + additionalQuantity;
    assertValidQuantity(newQuantity);
    
    logger.info("Upsert: Found existing item, incrementing quantity", {
      customerId,
      productId,
      oldQuantity: existing.item.quantity_owned,
      newQuantity,
    });

    await updateCollectionItemRaw(existing.id, {
      quantity_owned: newQuantity,
      // We don't overwrite user notes/grades on sync update
    });
  } else {
    // CREATE new
    const itemId = uuidv4();
    const handle = buildItemHandle(customerId, itemId);
    
    logger.info("Upsert: No existing item, creating new", {
      customerId,
      productId,
      handle,
    });

    const result = await shopifyGraphQL<{
      metaobjectCreate?: {
        metaobject?: { id: string } | null;
        userErrors?: Array<{ field: string[] | null; message: string }>;
      };
    }>(
      `mutation CreateCollectionItem($input: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $input) {
          metaobject { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          type: COLLECTION_ITEM_METAOBJECT_TYPE,
          handle,
          fields: [
            { key: "item_id", value: itemId },
            { key: "customer_id", value: customerId },
            { key: "product_id", value: productId },
            { key: "date_added_to_collection", value: new Date().toISOString().split("T")[0] },
            { key: "is_deleted", value: "false" },
            ...formatFields(additionalData),
          ],
        },
      }
    );

    const mutation = result.data?.metaobjectCreate;
    const errors = mutation?.userErrors ?? [];
    if (errors.length > 0) {
      logger.error("Failed to create synced collection item", {
        customerId,
        productId,
        errors,
      });
      throw new AppError(ErrorCode.GRAPHQL_ERROR, "Failed to create synced collection item");
    }

    if (!mutation?.metaobject) {
      logger.error("Synced item creation returned no metaobject and no userErrors", {
        customerId,
        productId,
      });
      throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not create the synced item");
    }
  }
}

/**
 * Serialize upserts for one customer/product within the current server instance.
 * This prevents same-instance webhook and batch jobs from losing read-modify-write increments.
 */
async function runWithProductUpsertLock<T>(
  lockKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const previousTail = productUpsertTails.get(lockKey) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail.then(() => currentLock);
  productUpsertTails.set(lockKey, currentTail);

  await previousTail;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (productUpsertTails.get(lockKey) === currentTail) {
      productUpsertTails.delete(lockKey);
    }
  }
}

// ─── Manual CRUD Methods ────────────────────────────────────────────────────

/**
 * Get a single item by handle (O(1) lookup).
 * Validates that the item belongs to the requested customer (defense in depth).
 */
export async function getCollectionItem(customerId: string, itemId: string): Promise<CollectionItem> {
  const handle = buildItemHandle(customerId, itemId);

  interface GetItemResponse {
    metaobjectByHandle?: {
      id: string;
      handle: string;
      fields?: Array<{ key: string; value: string }>;
    };
  }

  const result = await shopifyGraphQL<GetItemResponse>(
    `query GetItemByHandle($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) {
        id
        handle
        fields { key value }
      }
    }`,
    { handle: { type: COLLECTION_ITEM_METAOBJECT_TYPE, handle } }
  );

  const node = result.data?.metaobjectByHandle;
  if (!node) {
    throw new AppError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
  }

  const item = mapMetaobjectToItem(node);

  // Defense in depth: Verify data isolation
  if (item.customer_id !== customerId) {
    logger.error("Data isolation breach attempt prevented", {
      requestedCustomerId: customerId,
      actualCustomerId: item.customer_id,
      itemId,
    });
    throw new AppError(ErrorCode.ITEM_ACCESS_DENIED, "Access denied");
  }

  if (item.is_deleted) {
    throw new AppError(ErrorCode.ITEM_NOT_FOUND, "Item has been deleted");
  }

  return item;
}

/**
 * List items for a customer with optional filters and pagination.
 */
export async function listCollectionItems(
  customerId: string,
  filters: CollectionFilters
): Promise<CollectionPage> {
  // Build search query for Metaobjects
  const queryParts = [
    buildMetaobjectFieldFilter("customer_id", customerId),
    buildMetaobjectFieldFilter("is_deleted", "false"),
  ];

  if (filters.in_wishlist !== undefined) {
    queryParts.push(buildMetaobjectFieldFilter(
      "in_wishlist",
      filters.in_wishlist ? "true" : "false"
    ));
  }
  
  const queryStr = queryParts.join(" AND ");
  const limit = filters.first || COLLECTION_PAGE_SIZE;

  interface ListItemsResponse {
    metaobjects?: {
      nodes?: Array<{ id: string; handle: string; fields?: Array<{ key: string; value: string }> }>;
      pageInfo?: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    };
  }

  const result = await shopifyGraphQL<ListItemsResponse>(
    `query ListItems($query: String!, $first: Int!, $after: String) {
      metaobjects(type: "${COLLECTION_ITEM_METAOBJECT_TYPE}", first: $first, after: $after, query: $query) {
        nodes {
          id
          handle
          fields { key value }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }`,
    { query: queryStr, first: limit, after: filters.after }
  );

  const nodes = result.data?.metaobjects?.nodes || [];
  const items = nodes.map(mapMetaobjectToItem).filter((item: CollectionItem) => item.customer_id === customerId);

  const rawPageInfo = result.data?.metaobjects?.pageInfo;
  const pageInfo = rawPageInfo ? {
    hasNextPage: rawPageInfo.hasNextPage,
    hasPreviousPage: rawPageInfo.hasPreviousPage,
    startCursor: rawPageInfo.startCursor ?? undefined,
    endCursor: rawPageInfo.endCursor ?? undefined,
  } : {
    hasNextPage: false,
    hasPreviousPage: false,
  };

  return {
    items,
    pageInfo,
    totalItems: 0,
    totalValue: 0,
  };
}

/**
 * Update an existing item.
 */
export async function updateCollectionItem(
  customerId: string,
  itemId: string,
  updates: Partial<CollectionItem>
): Promise<CollectionItem> {
  // First get the item to verify ownership (defense in depth) and get its internal ID
  const handle = buildItemHandle(customerId, itemId);
  
  interface GetItemResponse {
    metaobjectByHandle?: { id: string; fields?: Array<{ key: string; value: string }> };
  }

  const getResult = await shopifyGraphQL<GetItemResponse>(
    `query GetItem($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id fields { key value } }
    }`,
    { handle: { type: COLLECTION_ITEM_METAOBJECT_TYPE, handle } }
  );

  const node = getResult.data?.metaobjectByHandle;
  if (!node) {
    throw new AppError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
  }

  const existingItem = mapMetaobjectToItem(node);
  if (existingItem.customer_id !== customerId) {
    throw new AppError(ErrorCode.ITEM_ACCESS_DENIED, "Access denied");
  }

  await updateCollectionItemRaw(node.id, updates);

  // Return updated item (merged)
  return { ...existingItem, ...updates };
}

/**
 * Internal raw update by Metaobject GID.
 */
async function updateCollectionItemRaw(metaobjectId: string, updates: Partial<CollectionItem>) {
  interface UpdateResponse {
    metaobjectUpdate?: {
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const result = await shopifyGraphQL<UpdateResponse>(
    `mutation UpdateCollectionItem($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        userErrors { field message }
      }
    }`,
    {
      id: metaobjectId,
      metaobject: {
        fields: formatFields(updates),
      },
    }
  );

  const mutation = result.data?.metaobjectUpdate;
  if (!mutation) {
    logger.error("Item update returned no mutation payload", { metaobjectId });
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not update the collection item");
  }

  const errors = mutation.userErrors || [];
  if (errors.length > 0) {
    logger.error("Failed to update metaobject", { metaobjectId, errors });
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Failed to update item");
  }
}

/**
 * Soft delete an item.
 */
export async function deleteCollectionItem(customerId: string, itemId: string): Promise<void> {
  await updateCollectionItem(customerId, itemId, { is_deleted: true });
}

/**
 * Permanently delete a customer-owned item for a verified privacy redaction request.
 * Normal collection deletion remains soft-delete; this method is GDPR-only.
 */
export async function listCollectionMetaobjectsForPrivacyDeletion(
  customerId: string
): Promise<Array<{ id: string; itemId: string }>> {
  const result = await shopifyGraphQL<{
    metaobjects?: {
      nodes?: Array<{
        id: string;
        fields?: Array<{ key: string; value: string }>;
      }>;
    };
  }>(
    `query ListItemsForPrivacyDeletion($query: String!, $first: Int!) {
      metaobjects(type: "${COLLECTION_ITEM_METAOBJECT_TYPE}", first: $first, query: $query) {
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
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not return privacy deletion items");
  }

  return (metaobjects.nodes ?? [])
    .map((node) => ({ node, item: mapMetaobjectToItem(node) }))
    .filter(({ item }) => item.customer_id === customerId)
    .map(({ node, item }) => ({ id: node.id, itemId: item.item_id }));
}

/** Permanently delete a previously customer-filtered metaobject for GDPR redaction. */
export async function hardDeleteMetaobjectForPrivacy(
  customerId: string,
  metaobjectId: string
): Promise<void> {
  const result = await shopifyGraphQL<{
    metaobjectDelete?: {
      deletedId?: string | null;
      userErrors?: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation DeleteCustomerMetaobjectForPrivacy($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }`,
    { id: metaobjectId }
  );

  const mutation = result.data?.metaobjectDelete;
  if (mutation?.userErrors?.length) {
    logger.error("Privacy deletion returned userErrors", {
      customerId,
      metaobjectId,
      errors: mutation.userErrors,
    });
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Failed to permanently delete customer data");
  }

  if (mutation?.deletedId !== metaobjectId) {
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not confirm customer data deletion");
  }
}

function assertValidQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_OWNED) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Quantity must be an integer between 1 and ${MAX_QUANTITY_OWNED}`
    );
  }
}
