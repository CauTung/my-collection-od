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

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
  console.error(
    "❌ Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN in .env"
  );
  process.exit(1);
}

const ADMIN_API_URL = `https://${SHOP_DOMAIN}/admin/api/2024-10/graphql.json`;

// ─── Namespace Configuration ──────────────────────────────────────────────────
// Change to "downies_collection" / "downies_product_data" if there is a conflict
const CUSTOMER_METAFIELD_NAMESPACE = "my_collection";
const PRODUCT_METAFIELD_NAMESPACE = "collectible_data";
const COLLECTION_ITEM_TYPE = "collection_item";
const DEDUP_LOCK_TYPE = "collection_dedup_lock";

async function shopifyGraphQL(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(ADMIN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN!, // Admin token, NOT App Secret
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<{ data: unknown; errors?: unknown[] }>;
}

// ─── Step 1: Check Namespace Collision ────────────────────────────────────────
async function checkNamespaceCollision() {
  console.log("\n📋 Step 1: Checking for namespace collisions...");

  // Check existing metaobject definitions
  const result = await shopifyGraphQL(`
    query GetMetaobjectDefinitions {
      metaobjectDefinitions(first: 50) {
        nodes {
          type
          name
        }
      }
    }
  `);

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
    `ℹ️  If severe conflict occurs, change the namespace in this file to "downies_collection"/"downies_product_data".`
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
        { key: "product_id", name: "Product ID", type: "single_line_text_field", required: true },
        { key: "customer_id", name: "Customer ID", type: "single_line_text_field", required: true },
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
        { key: "in_wishlist", name: "In Wishlist", type: "boolean" },
        { key: "is_deleted", name: "Is Deleted", type: "boolean" },
      ],
    },
  });

  const data = result.data as {
    metaobjectDefinitionCreate: {
      metaobjectDefinition?: { type: string; name: string };
      userErrors: Array<{ field: string[]; message: string; code: string }>;
    };
  };

  const { userErrors, metaobjectDefinition } = data.metaobjectDefinitionCreate;

  if (userErrors.length > 0) {
    const alreadyExists = userErrors.some(
      (e) => e.message.toLowerCase().includes("taken") || e.message.toLowerCase().includes("already")
    );
    if (alreadyExists) {
      console.log(`ℹ️  collection_item definition already exists — skipping this step.`);
    } else {
      console.error("❌ Error creating collection_item:", userErrors);
    }
  } else {
    console.log(`✅ Created metaobject definition: ${metaobjectDefinition?.name}`);
  }
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
        { key: "customer_id", name: "Customer ID", type: "single_line_text_field", required: true },
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

  const { userErrors, metaobjectDefinition } = data.metaobjectDefinitionCreate;

  if (userErrors.length > 0) {
    const alreadyExists = userErrors.some(
      (e) => e.message.toLowerCase().includes("taken") || e.message.toLowerCase().includes("already")
    );
    if (alreadyExists) {
      console.log(`ℹ️  dedup_lock definition already exists — skipping this step.`);
    } else {
      console.error("❌ Error creating dedup_lock:", userErrors);
    }
  } else {
    console.log(`✅ Created metaobject definition: ${metaobjectDefinition?.name}`);
  }
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

    const { userErrors, createdDefinition } = data.metafieldDefinitionCreate;

    if (userErrors.length > 0) {
      const alreadyExists = userErrors.some(
        (e) => e.message.toLowerCase().includes("taken") || e.message.toLowerCase().includes("already") || e.code === "TAKEN"
      );
      if (alreadyExists) {
        console.log(`ℹ️  ${CUSTOMER_METAFIELD_NAMESPACE}.${def.key} already exists.`);
      } else {
        console.error(`❌ Error creating ${def.key}:`, userErrors);
      }
    } else {
      console.log(`✅ Created: ${CUSTOMER_METAFIELD_NAMESPACE}.${createdDefinition?.key}`);
    }
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

    const { userErrors, createdDefinition } = data.metafieldDefinitionCreate;

    if (userErrors.length > 0) {
      const alreadyExists = userErrors.some(
        (e) => e.message.toLowerCase().includes("taken") || e.code === "TAKEN"
      );
      if (alreadyExists) {
        console.log(`ℹ️  ${PRODUCT_METAFIELD_NAMESPACE}.${def.key} already exists.`);
      } else {
        console.error(`❌ Error creating ${def.key}:`, userErrors);
      }
    } else {
      console.log(`✅ Created: ${PRODUCT_METAFIELD_NAMESPACE}.${createdDefinition?.key}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Downies My Collection — Shopify Setup Script");
  console.log(`📍 Shop: ${SHOP_DOMAIN}`);
  console.log("─".repeat(60));

  try {
    await checkNamespaceCollision();
    await createCollectionItemDefinition();
    await createDedupLockDefinition();
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
