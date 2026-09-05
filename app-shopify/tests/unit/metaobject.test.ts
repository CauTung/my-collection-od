/**
 * tests/unit/metaobject.test.ts
 *
 * Mutation correctness tests for collection metaobjects. Shopify responses are mocked;
 * concurrent behavior must still be verified on the real dev store before release.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCollectionItem,
  decrementCollectionItemByProduct,
  hardDeleteCollectionMetaobject,
  listCollectionMetaobjectsForPrivacyDeletion,
  updateCollectionItem,
  upsertCollectionItemByProduct,
} from "~/lib/metaobject.server";
import { shopifyGraphQL } from "~/lib/graphql-client.server";
import { ErrorCode } from "~/types";

vi.mock("~/lib/graphql-client.server", () => ({
  shopifyGraphQL: vi.fn(),
}));

const mockGraphQL = vi.mocked(shopifyGraphQL);
const CUSTOMER_ID = "gid://shopify/Customer/111";
const PRODUCT_ID = "gid://shopify/Product/999";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("collection item mutations", () => {
  it("rejects manual creation when Shopify returns userErrors", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectCreate: {
          metaobject: null,
          userErrors: [{ field: ["fields", "0"], message: "Invalid value" }],
        },
      },
    });

    await expect(
      createCollectionItem(CUSTOMER_ID, {
        product_id: PRODUCT_ID,
        quantity_owned: 1,
      })
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it("rejects manual creation when Shopify returns neither a node nor userErrors", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectCreate: {
          metaobject: null,
          userErrors: [],
        },
      },
    });

    await expect(
      createCollectionItem(CUSTOMER_ID, {
        product_id: PRODUCT_ID,
        quantity_owned: 1,
      })
    ).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
  });

  it("passes free-form text through GraphQL variables instead of the mutation string", async () => {
    const notes = `quote: " and GraphQL-looking text: }) { mutation { shop { name } } }`;
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectCreate: {
          metaobject: { id: "gid://shopify/Metaobject/1" },
          userErrors: [],
        },
      },
    });

    const createdItem = await createCollectionItem(CUSTOMER_ID, {
      product_id: PRODUCT_ID,
      quantity_owned: 1,
      user_notes: notes,
    });

    const [mutation, variables] = mockGraphQL.mock.calls[0];
    const typedVariables = variables as {
      metaobject: { fields: Array<{ key: string; value: string }> };
    };
    expect(mutation).not.toContain(notes);
    expect(typedVariables.metaobject.fields).toContainEqual({
      key: "item_id",
      value: createdItem.item_id,
    });
    expect(typedVariables.metaobject.fields).toContainEqual({
      key: "user_notes",
      value: notes,
    });
  });

  it("rejects an invalid sync quantity before calling Shopify", async () => {
    await expect(
      upsertCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, {
        quantity_owned: 0,
        source: "shopify_sync",
      })
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    expect(mockGraphQL).not.toHaveBeenCalled();
  });

  it("rejects an increment that would exceed the exact item quantity limit", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [
            {
              id: "gid://shopify/Metaobject/1",
              fields: [
                { key: "item_id", value: "item-1" },
                { key: "customer_id", value: CUSTOMER_ID },
                { key: "product_id", value: PRODUCT_ID },
                { key: "quantity_owned", value: "999" },
                { key: "is_deleted", value: "false" },
              ],
            },
          ],
        },
      },
    });

    await expect(
      upsertCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, {
        quantity_owned: 1,
        source: "shopify_sync",
      })
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    expect(mockGraphQL).toHaveBeenCalledTimes(1);
  });

  it("rejects synced creation when Shopify returns userErrors", async () => {
    mockGraphQL
      .mockResolvedValueOnce({
        data: {
          metaobjects: {
            nodes: [],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          metaobjectCreate: {
            metaobject: null,
            userErrors: [{ field: ["handle"], message: "Permission denied" }],
          },
        },
      });

    await expect(
      upsertCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, {
        quantity_owned: 1,
        source: "shopify_sync",
      })
    ).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
  });

  it("rejects an item search when Shopify omits the expected query payload", async () => {
    mockGraphQL.mockResolvedValueOnce({ data: {} });

    await expect(
      upsertCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, {
        quantity_owned: 1,
        source: "shopify_sync",
      })
    ).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
  });

  it("rejects an update when Shopify omits the expected mutation payload", async () => {
    mockGraphQL
      .mockResolvedValueOnce({
        data: {
          metaobjectByHandle: {
            id: "gid://shopify/Metaobject/1",
            fields: [
              { key: "item_id", value: "item-1" },
              { key: "customer_id", value: CUSTOMER_ID },
              { key: "product_id", value: PRODUCT_ID },
              { key: "quantity_owned", value: "1" },
              { key: "is_deleted", value: "false" },
            ],
          },
        },
      })
      .mockResolvedValueOnce({ data: {} });

    await expect(
      updateCollectionItem(CUSTOMER_ID, "item-1", { quantity_owned: 2 })
    ).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
  });

  it("serializes same-customer same-product upserts and preserves the exact quantity", async () => {
    let storedQuantity: number | null = null;
    let createCount = 0;
    let updateCount = 0;

    mockGraphQL.mockImplementation((operation, variables) => {
      if (operation.includes("FindExistingItem")) {
        return Promise.resolve({
          data: {
            metaobjects: {
              nodes:
                storedQuantity === null
                  ? []
                  : [
                      {
                        id: "gid://shopify/Metaobject/1",
                        fields: [
                          { key: "item_id", value: "existing-item" },
                          { key: "customer_id", value: CUSTOMER_ID },
                          { key: "product_id", value: PRODUCT_ID },
                          { key: "quantity_owned", value: String(storedQuantity) },
                          { key: "is_deleted", value: "false" },
                        ],
                      },
                    ],
            },
          },
        });
      }

      if (operation.includes("mutation CreateCollectionItem")) {
        createCount += 1;
        const input = (variables as {
          input: { fields: Array<{ key: string; value: string }> };
        }).input;
        storedQuantity = Number(
          input.fields.find(({ key }) => key === "quantity_owned")?.value
        );
        return Promise.resolve({
          data: {
            metaobjectCreate: {
              metaobject: { id: "gid://shopify/Metaobject/1" },
              userErrors: [],
            },
          },
        });
      }

      if (operation.includes("mutation UpdateCollectionItem")) {
        updateCount += 1;
        const metaobject = (variables as {
          metaobject: { fields: Array<{ key: string; value: string }> };
        }).metaobject;
        storedQuantity = Number(
          metaobject.fields.find(({ key }) => key === "quantity_owned")?.value
        );
        return Promise.resolve({
          data: {
            metaobjectUpdate: {
              userErrors: [],
            },
          },
        });
      }

      throw new Error(`Unexpected GraphQL operation: ${operation}`);
    });

    await Promise.all([
      upsertCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, {
        quantity_owned: 1,
        source: "shopify_sync",
      }),
      upsertCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, {
        quantity_owned: 2,
        source: "shopify_sync",
      }),
    ]);

    expect(createCount).toBe(1);
    expect(updateCount).toBe(1);
    expect(storedQuantity).toBe(3);
  });

  it("lists active and soft-deleted items for permanent privacy deletion", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjects: {
          nodes: [
            {
              id: "gid://shopify/Metaobject/active",
              fields: [
                { key: "item_id", value: "active-item" },
                { key: "customer_id", value: CUSTOMER_ID },
                { key: "is_deleted", value: "false" },
              ],
            },
            {
              id: "gid://shopify/Metaobject/deleted",
              fields: [
                { key: "item_id", value: "deleted-item" },
                { key: "customer_id", value: CUSTOMER_ID },
                { key: "is_deleted", value: "true" },
              ],
            },
            {
              id: "gid://shopify/Metaobject/other-customer",
              fields: [
                { key: "item_id", value: "private-item" },
                { key: "customer_id", value: "gid://shopify/Customer/222" },
              ],
            },
          ],
        },
      },
    });

    const items = await listCollectionMetaobjectsForPrivacyDeletion(CUSTOMER_ID);

    expect(items).toEqual([
      { id: "gid://shopify/Metaobject/active", itemId: "active-item" },
      { id: "gid://shopify/Metaobject/deleted", itemId: "deleted-item" },
    ]);
    const [query, variables] = mockGraphQL.mock.calls[0];
    expect(query).not.toContain("is_deleted");
    expect(variables).toEqual({
      query: `customer_id:'${CUSTOMER_ID}'`,
      first: 250,
    });
  });

  it("requires Shopify to confirm the exact permanently deleted metaobject", async () => {
    const metaobjectId = "gid://shopify/Metaobject/active";
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectDelete: {
          deletedId: metaobjectId,
          userErrors: [],
        },
      },
    });

    await expect(
      hardDeleteCollectionMetaobject(CUSTOMER_ID, metaobjectId)
    ).resolves.toBeUndefined();
    expect(mockGraphQL).toHaveBeenCalledTimes(1);
  });

  it("rejects permanent deletion when Shopify returns userErrors", async () => {
    mockGraphQL.mockResolvedValueOnce({
      data: {
        metaobjectDelete: {
          deletedId: null,
          userErrors: [{ field: ["id"], message: "Permission denied" }],
        },
      },
    });

    await expect(
      hardDeleteCollectionMetaobject(CUSTOMER_ID, "gid://shopify/Metaobject/active")
    ).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
  });

  it("serializes concurrent webhook decrements and preserves the exact quantity", async () => {
    let storedQuantity = 5;
    let updateCount = 0;

    mockGraphQL.mockImplementation((operation, variables) => {
      if (operation.includes("FindExistingItem")) {
        return Promise.resolve({
          data: {
            metaobjects: {
              nodes: [
                {
                  id: "gid://shopify/Metaobject/1",
                  fields: [
                    { key: "item_id", value: "item-1" },
                    { key: "customer_id", value: CUSTOMER_ID },
                    { key: "product_id", value: PRODUCT_ID },
                    { key: "quantity_owned", value: String(storedQuantity) },
                    { key: "is_deleted", value: "false" },
                  ],
                },
              ],
            },
          },
        });
      }

      if (operation.includes("mutation UpdateCollectionItem")) {
        updateCount += 1;
        const metaobject = (variables as {
          metaobject: { fields: Array<{ key: string; value: string }> };
        }).metaobject;
        storedQuantity = Number(
          metaobject.fields.find(({ key }) => key === "quantity_owned")?.value
        );
        return Promise.resolve({
          data: { metaobjectUpdate: { userErrors: [] } },
        });
      }

      return Promise.reject(new Error(`Unexpected GraphQL operation: ${operation}`));
    });

    await Promise.all([
      decrementCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, 1),
      decrementCollectionItemByProduct(CUSTOMER_ID, PRODUCT_ID, 2),
    ]);

    expect(updateCount).toBe(2);
    expect(storedQuantity).toBe(2);
  });
});
