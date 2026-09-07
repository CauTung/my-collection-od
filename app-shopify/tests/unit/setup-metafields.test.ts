import { afterEach, describe, expect, it, vi } from "vitest";

const { graphqlMock } = vi.hoisted(() => ({ graphqlMock: vi.fn() }));
vi.mock("../../app/lib/graphql-client.server", () => ({ shopifyGraphQL: graphqlMock }));

const createOperations = [
  "CreateCollectionItemDefinition",
  "CreateDedupLockDefinition",
  "CreateCustomerMetafieldDefinition",
  "CreateProductMetafieldDefinition",
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  graphqlMock.mockReset();
});

describe("Shopify schema setup failure propagation", () => {
  it.each(createOperations)("exits unsuccessfully when %s omits its created node", async (failedOperation) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    graphqlMock.mockImplementation((query: string) => {
      if (query.includes("GetMetaobjectDefinitions")) {
        return { data: { metaobjectDefinitions: { nodes: [] } } };
      }
      if (query.includes("GetFilterableMetaobjectDefinition")) {
        return { data: { metaobjectDefinitionByType: {
          id: "definition-1",
          fieldDefinitions: ["customer_id", "product_id", "is_deleted", "in_wishlist"].map((key) => ({
            key, capabilities: { adminFilterable: { enabled: true, eligible: true } },
          })),
        } } };
      }
      if (query.includes("VerifyMetaobjectFieldSearch")) return { data: { metaobjects: { nodes: [] } } };
      const omitted = query.includes(failedOperation);
      if (query.includes("metaobjectDefinitionCreate")) {
        return { data: { metaobjectDefinitionCreate: {
          userErrors: [], metaobjectDefinition: omitted ? null : { type: "collection_item", name: "Collection Item" },
        } } };
      }
      return { data: { metafieldDefinitionCreate: {
        userErrors: [], createdDefinition: omitted ? null : { key: "field", namespace: "namespace" },
      } } };
    });

    await import("../../scripts/setup-metafields");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.some((call) => call.some((value: unknown) => value instanceof Error && value.message.includes("missing created definition")))).toBe(true);
    expect(logSpy.mock.calls.some((call) => call.some((value: unknown) => typeof value === "string" && value.includes("Setup complete!")))).toBe(false);
  });
});
