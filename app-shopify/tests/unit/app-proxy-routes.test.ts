/**
 * tests/unit/app-proxy-routes.test.ts
 *
 * Regression coverage for the customer API trust boundary. Every customer-facing route
 * must reject a direct request to the backend before invoking collection business logic.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loader as collectionLoader, action as collectionAction } from "~/routes/api.collection";
import { action as itemAction } from "~/routes/api.collection.$item_id";
import { action as wishlistAction } from "~/routes/api.collection.$item_id.wishlist";
import { loader as statsLoader } from "~/routes/api.collection.stats";
import { action as syncAction } from "~/routes/api.collection.sync";
import { loader as dashboardLoader } from "~/routes/app.my-collection";

type RouteInvocation = {
  name: string;
  invoke: () => Promise<Response>;
};

function createUnsignedRequest(path: string, method = "GET"): Request {
  return new Request(
    `https://app.example.com${path}?logged_in_customer_id=99999&shop=test-shop.myshopify.com`,
    { method }
  );
}

describe("customer-facing App Proxy routes", () => {
  beforeEach(() => {
    process.env.SHOPIFY_APP_SECRET = "route_test_secret";
    process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
  });

  it("returns 401 for unsigned requests on every customer route", async () => {
    const invocations: RouteInvocation[] = [
      {
        name: "collection loader",
        invoke: () =>
          collectionLoader({
            request: createUnsignedRequest("/api/collection"),
          } as Parameters<typeof collectionLoader>[0]),
      },
      {
        name: "collection create action",
        invoke: () =>
          collectionAction({
            request: createUnsignedRequest("/api/collection", "POST"),
          } as Parameters<typeof collectionAction>[0]),
      },
      {
        name: "collection item action",
        invoke: () =>
          itemAction({
            request: createUnsignedRequest("/api/collection/item-1", "DELETE"),
            params: { item_id: "item-1" },
          } as unknown as Parameters<typeof itemAction>[0]),
      },
      {
        name: "wishlist action",
        invoke: () =>
          wishlistAction({
            request: createUnsignedRequest("/api/collection/item-1/wishlist", "POST"),
            params: { item_id: "item-1" },
          } as unknown as Parameters<typeof wishlistAction>[0]),
      },
      {
        name: "stats loader",
        invoke: () =>
          statsLoader({
            request: createUnsignedRequest("/api/collection/stats"),
          } as Parameters<typeof statsLoader>[0]),
      },
      {
        name: "sync action",
        invoke: () =>
          syncAction({
            request: createUnsignedRequest("/api/collection/sync", "POST"),
          } as Parameters<typeof syncAction>[0]),
      },
      {
        name: "dashboard loader",
        invoke: () =>
          dashboardLoader({
            request: createUnsignedRequest("/apps/my-collection"),
          } as Parameters<typeof dashboardLoader>[0]),
      },
    ];

    const results = await Promise.all(
      invocations.map(async ({ name, invoke }) => ({ name, response: await invoke() }))
    );

    expect(results).toHaveLength(7);
    for (const { name, response } of results) {
      expect(response.status, name).toBe(401);
      await expect(response.json(), name).resolves.toMatchObject({ error: "HMAC_INVALID" });
    }
  });
});
