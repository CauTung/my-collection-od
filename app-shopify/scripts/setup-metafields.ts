/**
 * scripts/setup-metafields.ts
 *
 * Day 1 Setup Script — MUST be run before coding any routes.
 *
 * Purpose:
 * 1. Check for namespace collisions with existing apps on Shopify Admin.
 * 2. Create Metaobject definitions: collection_item + dedup_lock.
 * 3. Create Customer Metafield definitions: my_collection.* (or downies_collection.*).
 * 4. Create Product Metafield definitions: collectible_data.* (or downies_product_data.*).
 *
 * Usage: npx tsx scripts/setup-metafields.ts
 *
 * Required environment variables in .env:
 *   SHOPIFY_ADMIN_ACCESS_TOKEN — Admin access token (NOT App Secret)
 *   SHOPIFY_SHOP_DOMAIN       — Store domain (e.g.: your-store.myshopify.com)
 *
 * Make sure to use the correct OAuth token (Admin API token) and handle namespace collisions properly.
 */

import "dotenv/config";
import { buildMetaobjectFieldFilter } from "../app/lib/metaobject-search.server";
import { shopifyGraphQL } from "../app/lib/graphql-client.server";
import { assertSchemaMutationSucceeded } from "./schema-setup-errors";
import {
  COLLECTION_DEDUP_LOCK_METAOBJECT_TYPE,
  COLLECTION_ITEM_METAOBJECT_TYPE,
  CUSTOMER_METAFIELD_NAMESPACE,
  PRODUCT_METAFIELD_NAMESPACE,
  SCHEMA_DEFINITION_PAGE_SIZE,
} from "../app/config/constants";

// ─── Namespace Configuration ──────────────────────────────────────────────────
// Change to "downies_collection" / "downies_product_data" if there is a conflict
const COLLECTION_ITEM_TYPE = COLLECTION_ITEM_METAOBJECT_TYPE;
const DEDUP_LOCK_TYPE = COLLECTION_DEDUP_LOCK_METAOBJECT_TYPE;

// ─── Step 1: Check Namespace Collision ────────────────────────────────────────
async function checkNamespaceCollision() {
  console.log("\n📋 Step 1: Checking for namespace collisions...");

  // Check existing metaobject definitions
  const result = await shopifyGraphQL(`
    query GetMetaobjectDefinitions($first: Int!) {
      metaobjectDefinitions(first: $first) {
        nodes {
          type
          name
        }
      }
    }
  `, { first: SCHEMA_DEFINITION_PAGE_SIZE });

  const data = result.data as {
    metaobjectDefinitions: { nodes: Array<{ type: string; name: string }> };
  };

  if (!data || !data.metaobjectDefinitions) {
    console.error("GraphQL Error:", JSON.stringify(result, null, 2));
    throw new Error("Failed to fetch metaobjectDefinitions");
  }

  const existingTypes = data.metaobjectDefinitions.nodes.map((n) => n.type);

  if (existingTypes.includes(COLLECTION_ITEM_TYPE)) {
    console.warn(
      `⚠️  Metaobject type "${COLLECTION_ITEM_TYPE}" already exists. Might be from a previous setup — check carefully before proceeding.`
    );
  } else {
    console.log(`✅ Metaobject type "${COLLECTION_ITEM_TYPE}" — no conflict.`);
  }

  if (existingTypes.includes(DEDUP_LOCK_TYPE)) {
    console.warn(
      `⚠️  Metaobject type "${DEDUP_LOCK_TYPE}" already exists.`
    );
  } else {
    console.log(`✅ Metaobject type "${DEDUP_LOCK_TYPE}" — no conflict.`);
  }

  console.log(
    `ℹ️  If severe conflict occurs, change the namespace in app/config/constants.ts; existing data requires migration. Use to "downies_collection"/"downies_product_data".`
  );
}

// ─── Step 2: Create collection_item Metaobject Definition ────────────────────
async function createCollectionItemDefinition() {
  console.log("\n📦 Step 2: Creating collection_item metaobject definition...");

  const result = await shopifyGraphQL(`
    mutation CreateCollectionItemDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition {
          type
          name
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `, {
    definition: {
      type: COLLECTION_ITEM_TYPE,
      name: "Collection Item",
      fieldDefinitions: [
        { key: "item_id", name: "Item ID", type: "single_line_text_field", required: true },
        { key: "product_id", name: "Product ID", type: "single_line_text_field", required: true, capabilities: { adminFilterable: { enabled: true } } },
        { key: "customer_id", name: "Customer ID", type: "single_line_text_field", required: true, capabilities: { adminFilterable: { enabled: true } } },
        { key: "sku_code", name: "SKU Code", type: "single_line_text_field" },
        { key: "source", name: "Source", type: "single_line_text_field", required: true },
        { key: "external_order_id", name: "External Order ID", type: "single_line_text_field" },
        { key: "quantity_owned", name: "Quantity Owned", type: "number_integer", required: true },
        { key: "date_added_to_collection", name: "Date Added", type: "date" },
        { key: "purchase_date", name: "Purchase Date", type: "date" },
        { key: "purchase_price", name: "Purchase Price", type: "number_decimal" },
        { key: "current_market_value", name: "Current Market Value", type: "number_decimal" },
        { key: "certificate_number", name: "Certificate Number", type: "single_line_text_field" },
        { key: "user_grade", name: "User Grade", type: "single_line_text_field" },
        { key: "user_notes", name: "User Notes", type: "multi_line_text_field" },
        { key: "in_wishlist", name: "In Wishlist", type: "boolean", capabilities: { adminFilterable: { enabled: true } } },
        { key: "is_deleted", name: "Is Deleted", type: "boolean", capabilities: { adminFilterable: { enabled: true } } },
      ],
    },
  });

  const data = result.data as {
    metaobjectDefinitionCreate: {
      metaobjectDefinition?: { type: string; name: string };
      userErrors: Array<{ field: string[]; message: string; code: string }>;
    };
  };

  const mutation = data?.metaobjectDefinitionCreate;
  const status = assertSchemaMutationSucceeded(
    "Create collection_item definition",
    mutation?.userErrors,
    mutation?.metaobjectDefinition
  );
  console.log(`collection_item definition: ${status}`);
}

// ─── Step 3: Create dedup_lock Metaobject Definition ─────────────────────────
async function createDedupLockDefinition() {
  console.log("\n🔒 Step 3: Creating dedup_lock metaobject definition...");

  const result = await shopifyGraphQL(`
    mutation CreateDedupLockDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition {
          type
          name
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `, {
    definition: {
      type: DEDUP_LOCK_TYPE,
      name: "Collection Dedup Lock",
      fieldDefinitions: [
        { key: "customer_id", name: "Customer ID", type: "single_line_text_field", required: true, capabilities: { adminFilterable: { enabled: true } } },
        { key: "external_order_id", name: "External Order ID", type: "single_line_text_field", required: true },
      ],
    },
  });

  const data = result.data as {
    metaobjectDefinitionCreate: {
      metaobjectDefinition?: { type: string; name: string };
      userErrors: Array<{ field: string[]; message: string; code: string }>;
    };
  };

  const mutation = data?.metaobjectDefinitionCreate;
  const status = assertSchemaMutationSucceeded(
    "Create dedup_lock definition",
    mutation?.userErrors,
    mutation?.metaobjectDefinition
  );
  console.log(`dedup_lock definition: ${status}`);
}

// ─── Step 4: Create Customer Metafield Definitions ────────────────────────────
async function createCustomerMetafieldDefinitions() {
  console.log("\n👤 Step 4: Creating Customer Metafield definitions...");

  const definitions = [
    { key: "total_items", name: "Total Items", type: "number_integer", description: "Cached total collection items count" },
    { key: "total_value", name: "Total Value", type: "number_decimal", description: "Cached total collection value (AUD)" },
    { key: "created_at", name: "Collection Created At", type: "date_time", description: "When the customer first created their collection" },
    { key: "last_updated", name: "Last Updated", type: "date_time", description: "Last time stats were recalculated" },
    { key: "sync_status", name: "Sync Status", type: "single_line_text_field", description: "Current batch sync status: idle|syncing|queued|completed|failed" },
    { key: "sync_progress", name: "Sync Progress", type: "json", description: "Batch sync progress: { processed, total, failed }" },
  ];

  for (const def of definitions) {
    const result = await shopifyGraphQL(`
      mutation CreateCustomerMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            key
            namespace
            name
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `, {
      definition: {
        namespace: CUSTOMER_METAFIELD_NAMESPACE,
        key: def.key,
        name: def.name,
        description: def.description,
        type: def.type,
        ownerType: "CUSTOMER",
      },
    });

    const data = result.data as {
      metafieldDefinitionCreate: {
        createdDefinition?: { key: string; namespace: string; name: string };
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    };

    const mutation = data?.metafieldDefinitionCreate;
    const status = assertSchemaMutationSucceeded(
      `Create ${CUSTOMER_METAFIELD_NAMESPACE}.${def.key}`,
      mutation?.userErrors,
      mutation?.createdDefinition
    );
    console.log(`${CUSTOMER_METAFIELD_NAMESPACE}.${def.key}: ${status}`);
  }
}

// ─── Step 5: Create Product Metafield Definitions ────────────────────────────
async function createProductMetafieldDefinitions() {
  console.log("\n🏅 Step 5: Creating Product (collectible_data) Metafield definitions...");

  const definitions = [
    { key: "erp_sku", name: "ERP SKU", type: "single_line_text_field" },
    { key: "denomination", name: "Denomination", type: "single_line_text_field" },
    { key: "country_of_issue", name: "Country of Issue", type: "single_line_text_field" },
    { key: "material", name: "Material", type: "single_line_text_field" },
    { key: "year_of_issue", name: "Year of Issue", type: "single_line_text_field" },
    { key: "issuer", name: "Issuer", type: "single_line_text_field" },
    { key: "quality", name: "Quality", type: "single_line_text_field" },
    { key: "grade", name: "Grade", type: "single_line_text_field" },
    { key: "limited_mintage", name: "Limited Mintage", type: "boolean" },
    { key: "mintage_limit", name: "Mintage Limit", type: "number_integer" },
  ];

  for (const def of definitions) {
    const result = await shopifyGraphQL(`
      mutation CreateProductMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            key
            namespace
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `, {
      definition: {
        namespace: PRODUCT_METAFIELD_NAMESPACE,
        key: def.key,
        name: def.name,
        type: def.type,
        ownerType: "PRODUCT",
      },
    });

    const data = result.data as {
      metafieldDefinitionCreate: {
        createdDefinition?: { key: string; namespace: string };
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    };

    const mutation = data?.metafieldDefinitionCreate;
    const status = assertSchemaMutationSucceeded(
      `Create ${PRODUCT_METAFIELD_NAMESPACE}.${def.key}`,
      mutation?.userErrors,
      mutation?.createdDefinition
    );
    console.log(`${PRODUCT_METAFIELD_NAMESPACE}.${def.key}: ${status}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function ensureFilterableMetaobjectFields(
  metaobjectType: string,
  requiredFieldKeys: readonly string[]
) {
  const lookupResult = await shopifyGraphQL(`
    query GetFilterableMetaobjectDefinition($type: String!) {
      metaobjectDefinitionByType(type: $type) {
        id
        fieldDefinitions {
          key
          capabilities {
            adminFilterable { enabled eligible }
          }
        }
      }
    }
  `, { type: metaobjectType });

  const lookupData = lookupResult.data as {
    metaobjectDefinitionByType?: {
      id: string;
      fieldDefinitions: Array<{
        key: string;
        capabilities: { adminFilterable: { enabled: boolean; eligible: boolean } };
      }>;
    } | null;
  };
  const definition = lookupData.metaobjectDefinitionByType;
  if (!definition) {
    throw new Error(`Metaobject definition "${metaobjectType}" was not found after setup`);
  }

  const fieldsToEnable = requiredFieldKeys.filter((key) => {
    const field = definition.fieldDefinitions.find((candidate) => candidate.key === key);
    if (!field) {
      throw new Error(`Required field "${metaobjectType}.${key}" does not exist`);
    }
    if (!field.capabilities.adminFilterable.eligible) {
      throw new Error(`Field "${metaobjectType}.${key}" is not eligible for filtering`);
    }
    return !field.capabilities.adminFilterable.enabled;
  });

  if (fieldsToEnable.length === 0) {
    console.log(`Metaobject filter capabilities already enabled for ${metaobjectType}.`);
    return;
  }

  const updateResult = await shopifyGraphQL(`
    mutation EnableMetaobjectFieldFilters(
      $id: ID!
      $definition: MetaobjectDefinitionUpdateInput!
    ) {
      metaobjectDefinitionUpdate(id: $id, definition: $definition) {
        metaobjectDefinition { id }
        userErrors { field message code }
      }
    }
  `, {
    id: definition.id,
    definition: {
      fieldDefinitions: fieldsToEnable.map((key) => ({
        update: {
          key,
          capabilities: { adminFilterable: { enabled: true } },
        },
      })),
    },
  });

  const updateData = updateResult.data as {
    metaobjectDefinitionUpdate?: {
      metaobjectDefinition?: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string; code: string }>;
    };
  };
  const mutation = updateData.metaobjectDefinitionUpdate;
  if (!mutation?.metaobjectDefinition || mutation.userErrors.length > 0) {
    throw new Error(
      `Failed to enable filters for ${metaobjectType}: ${JSON.stringify(mutation?.userErrors ?? [])}`
    );
  }

  console.log(`Enabled filter capabilities for ${metaobjectType}: ${fieldsToEnable.join(", ")}`);
}

async function verifyMetaobjectFieldSearch(metaobjectType: string) {
  const result = await shopifyGraphQL(`
    query VerifyMetaobjectFieldSearch($type: String!, $query: String!) {
      metaobjects(type: $type, first: 1, query: $query) {
        nodes { id }
      }
    }
  `, {
    type: metaobjectType,
    query: buildMetaobjectFieldFilter("customer_id", "filter-contract-probe"),
  });

  const data = result.data as { metaobjects?: { nodes: Array<{ id: string }> } };
  if (result.errors?.length || !data.metaobjects) {
    throw new Error(
      `Field search verification failed for ${metaobjectType}: ${JSON.stringify(result.errors ?? [])}`
    );
  }

  console.log(`Verified field-search contract for ${metaobjectType}.`);
}

async function main() {
  console.log("🚀 Downies My Collection — Shopify Setup Script");
  console.log(`📍 Shop: ${process.env.SHOPIFY_SHOP_DOMAIN ?? "not configured"}`);
  console.log("─".repeat(60));

  try {
    await checkNamespaceCollision();
    await createCollectionItemDefinition();
    await createDedupLockDefinition();
    await ensureFilterableMetaobjectFields(COLLECTION_ITEM_TYPE, [
      "customer_id",
      "product_id",
      "is_deleted",
      "in_wishlist",
    ]);
    await ensureFilterableMetaobjectFields(DEDUP_LOCK_TYPE, ["customer_id"]);
    await verifyMetaobjectFieldSearch(COLLECTION_ITEM_TYPE);
    await verifyMetaobjectFieldSearch(DEDUP_LOCK_TYPE);
    await createCustomerMetafieldDefinitions();
    await createProductMetafieldDefinitions();

    console.log("\n" + "─".repeat(60));
    console.log("✅ Setup complete! Check Shopify Admin > Content > Metaobjects to verify.");
    console.log("⚠️  NOTE: This is the script result, verify directly on Shopify Admin before coding routes.");
  } catch (err) {
    console.error("\n❌ Setup failed:", err);
    process.exit(1);
  }
}

main();
