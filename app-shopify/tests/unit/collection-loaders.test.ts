import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as collectionLoader } from "~/routes/api.collection";
import { loader as statsLoader } from "~/routes/api.collection.stats";
import { listCollectionItems } from "~/lib/metaobject.server";
import { getCustomerCollectionMetafields } from "~/lib/metafield.server";
vi.mock("~/lib/session.server", () => ({ authenticateAppProxyRequest: vi.fn(() => ({ customer_id: "customer-a" })) }));
vi.mock("~/lib/metaobject.server", () => ({ listCollectionItems: vi.fn(), createCollectionItem: vi.fn() }));
vi.mock("~/lib/metafield.server", () => ({ getCustomerCollectionMetafields: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe("collection loader error states", () => {
  it("returns an infrastructure error instead of a successful empty collection", async () => {
    vi.mocked(listCollectionItems).mockRejectedValueOnce(new Error("upstream offline"));
    const response = await collectionLoader({ request: new Request("https://example.com/api/collection") } as Parameters<typeof collectionLoader>[0]);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "INTERNAL_ERROR", message: "An unexpected error occurred" });
  });
  it("returns a successful empty collection only when the data source reports one", async () => {
    vi.mocked(listCollectionItems).mockResolvedValueOnce({ items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false }, totalItems: 0, totalValue: 0 });
    const response = await collectionLoader({ request: new Request("https://example.com/api/collection") } as Parameters<typeof collectionLoader>[0]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } });
  });
  it("returns an infrastructure error instead of zero stats and idle sync", async () => {
    vi.mocked(getCustomerCollectionMetafields).mockRejectedValueOnce(new Error("upstream offline"));
    const response = await statsLoader({ request: new Request("https://example.com/api/collection/stats") } as Parameters<typeof statsLoader>[0]);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "INTERNAL_ERROR", message: "An unexpected error occurred" });
  });
});
