import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("app/my-collection", "routes/app.my-collection.tsx", { id: "app-my-collection" }),
  route("apps/my-collection", "routes/app.my-collection.tsx", { id: "apps-my-collection" }),
  route("apps/my-collection/*", "routes/app.my-collection.tsx", { id: "apps-my-collection-splat" }),
  route("api/collection", "routes/api.collection.ts"),
  route("api/collection/:item_id", "routes/api.collection.$item_id.ts"),
  route("api/collection/:item_id/wishlist", "routes/api.collection.$item_id.wishlist.ts"),
  route("api/collection/stats", "routes/api.collection.stats.ts"),
  route("api/collection/sync", "routes/api.collection.sync.ts"),
  route("api/webhooks/orders-paid", "routes/api.webhooks.orders-paid.ts"),
  route("api/webhooks/orders-cancelled", "routes/api.webhooks.orders-cancelled.ts"),
  route("api/webhooks/refunds-create", "routes/api.webhooks.refunds-create.ts"),
  route("api/webhooks/customers-data-request", "routes/api.webhooks.customers-data-request.ts"),
  route("api/webhooks/customers-redact", "routes/api.webhooks.customers-redact.ts"),
  route("api/webhooks/shop-redact", "routes/api.webhooks.shop-redact.ts"),
] satisfies RouteConfig;
