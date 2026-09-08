# Architecture Overview — Downies "My Collection"

> **BẮTBUỘC CẬP NHẬT** mỗi khi có thay đổi về cấu trúc thư mục, luồng dữ liệu, exception handling hoặc performance optimization. Xem AGENTS.md mục 5.

**Phiên bản**: 0.1.0 (Phase 1 Setup)
**Cập nhật lần cuối**: 2026-09-05
**Trạng thái**: Scaffold + Phase 1 files (constants, types, .env.example, setup script)

---

## 1. Tổng Quan Hệ Thống

Downies "My Collection" là Shopify Plus app cho phép collector theo dõi bộ sưu tập numismatic (tiền xu, huy chương). Kiến trúc thuần Shopify Native — **không có database ngoài, không Redis**.

```
Collector Browser
    │  HTTPS /apps/my-collection
    ▼
Shopify App Proxy
    │  HMAC verified (SHOPIFY_APP_SECRET)
    ▼
Remix Backend (React Router v7, Serverless — Vercel)
    │  Admin GraphQL (X-Shopify-Access-Token = SHOPIFY_ADMIN_ACCESS_TOKEN)
    ▼
Shopify Native Data Layer
    ├── Metaobjects: collection_item (CRUD)
    ├── Metaobjects: collection_dedup_lock (atomic dedup)
    ├── Customer Metafields: my_collection.* (cached stats + sync state)
    └── Product Metafields: collectible_data.* (coin classifier)
```

---

## 2. Hai Secret Khác Nhau — Không Lẫn

| Secret | Mục đích | File dùng |
|---|---|---|
| `SHOPIFY_APP_SECRET` | Verify HMAC (App Proxy + Webhook) | `hmac.server.ts` duy nhất |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin GraphQL API calls | `graphql-client.server.ts` duy nhất |

---

## 3. Data Schema

### 3.1 Metaobject `collection_item`
Handle format: `{customer_id}-{item_id}`

| Field | Type |
|---|---|
| item_id | Text (UUID v4) |
| product_id | Text (GID) |
| customer_id | Text (GID) — giữ lại trong map để defense-in-depth |
| sku_code | Text (ERP-ready) |
| source | Text: shopify_sync \| erp_sync \| manual_entry |
| external_order_id | Text (GID) |
| quantity_owned | Integer ≥1, max 999 |
| date_added_to_collection | Date |
| purchase_date | Date |
| purchase_price | Decimal |
| current_market_value | Decimal (user-declared, NOT market API) |
| certificate_number | Text max 50 |
| user_grade | Text max 200 |
| user_notes | Multi-line max 500 |
| in_wishlist | Boolean |
| is_deleted | Boolean (soft delete) |

### 3.2 Metaobject `collection_dedup_lock` (tách riêng)
Handle format: `dedup-{customer_id}-{order_id}`

Lý do tách riêng: collection_item không nên gánh 2 vai trò (data + lock).

| Field | Type |
|---|---|
| customer_id | Text |
| external_order_id | Text |

### 3.3 Customer Metafields `my_collection.*`
| Field | Mô tả |
|---|---|
| total_items | Cached count |
| total_value | Cached Σ current_market_value × quantity |
| created_at | Ngày tạo collection lần đầu |
| last_updated | Timestamp cập nhật gần nhất |
| sync_status | idle \| syncing \| queued \| completed \| failed |
| sync_progress | JSON: { processed, total, failed } |

### 3.4 Product Metafields `collectible_data.*`
denomination, country_of_issue, material, year_of_issue, issuer, quality, grade, limited_mintage, mintage_limit, erp_sku

---

## 4. Module Responsibilities

| Module | Trách nhiệm duy nhất |
|---|---|
| `hmac.server.ts` | Verify HMAC — App Proxy groups duplicate non-identity keys with commas, requires one copy of every identity parameter, validates a five-minute signed timestamp window, then compares the signature; Webhook verifies raw body |
| `webhook.server.ts` | Shared webhook boundary: raw-body HMAC, signed shop binding, exact topic binding, then JSON parsing |
| `error-handler.server.ts` | Converts App Proxy authentication failures to HTTP 401 and unexpected route failures to HTTP 500; routes do not swallow errors as HTTP 200 |
| `session.server.ts` | Atomically verify App Proxy HMAC, bind signed `shop` to `SHOPIFY_SHOP_DOMAIN`, then extract the signed customer context through `authenticateAppProxyRequest()` |
| `graphql-client.server.ts` | Wrapper duy nhất cho Admin GraphQL `2026-07` cho cả runtime và schema setup — retry/backoff/proactive throttle; version lấy từ constants |
| `shopify-domain.server.ts` | Normalize `SHOPIFY_SHOP_DOMAIN` (hostname hoặc HTTPS URL) trước khi tạo Admin API URL |
| `dedup.server.ts` | claimOrderSync() atomic — metaobjectCreate + catch userErrors |
| `order.server.ts` | Resolve minimal Order customer context for refund payloads through Admin GraphQL |
| `metaobject.server.ts` | CRUD collection_item — validates mutation payloads/userErrors and serializes same-instance product upserts; nơi DUY NHẤT gọi GraphQL cho type này |
| `metaobject-search.server.ts` | Tạo Metaobject field filter đúng contract `fields.{key}:"value"` và escape search value |
| `metafield.server.ts` | CRUD Customer/Product Metafields |
| `stats.server.ts` | recalculateAndCacheStats() — sau mỗi CRUD |
| `product-filter.server.ts` | filterCoinLineItems() — coin vs accessory classifier |
| `batch-sync.server.ts` | Historical Batch Sync engine (async model, progress polling) |
| `background-task.server.ts` | Đăng ký completion promise bằng Vercel `waitUntil`; local/test tiếp tục in-process |
| `idempotency.server.ts` | Cache idempotency key theo customer + operation + resource + client UUID; failed mutation release claim để request có thể retry |
| `queue.server.ts` | FIFO scheduler theo instance: cap active jobs, giữ callback queued, drain khi slot rảnh, coalesce theo customer |
| `shopify-id.server.ts` | Validate và tách numeric/safe segment từ Shopify GID cho order filters và handles |
| `error-handler.server.ts` | AppError class + withErrorHandler() wrapper |
| `logger.server.ts` | Structured JSON logger, auto-redact PII |

Build thường (`npm run build`) chỉ compile React Router và dùng official Vercel preset; không gọi Shopify. Native schema chỉ được provision/migrate bằng lệnh operator có chủ đích `npm run setup:shopify-schema`.

---

## 5. Luồng Dữ Liệu

### 5.1 Real-time Webhook (orders/paid)
```
Shopify → authenticateWebhookRequest(raw HMAC + shop + topic)
    → fetch collectible_data metafields → filterCoinLineItems(lineItems, collectibleProductIds)
    → check cancellation claim để không recreate order bị cancel đến trước
    → claimOrderSync() (atomic) sau khi read-only prerequisites thành công
    → serialize theo customer/product trong cùng server instance
    → upsert collection_item theo product_id (không luôn tạo mới)
    → validate quantity 1..999 + reject userErrors/missing mutation payload
    → recalculateAndCacheStats()
    → Yotpo +50pts (non-blocking, lần đầu tạo collection)
```

### 5.4 Refund, Cancellation và GDPR

```
orders/cancelled → filter collectible products → cancellation claim → serialized decrement/soft-delete
refunds/create → query Order customer bằng order_id → filter → refund claim → serialized decrement/soft-delete
customers/redact → list cả active + soft-deleted collection items và dedup locks theo customer → hard-delete từng Metaobject theo chunk 5
shop/redact → ACK sau auth vì ứng dụng không có external shop database
```

GDPR hard-delete luôn đọc lại first page sau mỗi batch; không tái sử dụng cursor trong lúc result set đang bị xóa. Nếu bất kỳ deletion nào fail, route trả non-2xx để Shopify retry thay vì ACK sai.

Giới hạn hiện tại cần quyết định trước go-live:

- Paid/cancel/refund claim event trước khi ghi từng item. Nếu một item fail sau khi các item khác đã thành công, route hiện ACK 200 và giữ claim; chưa có durable item-level retry để phục hồi chính xác một lần.
- Cancellation đến trước paid đã có guard cho luồng tuần tự. Refund đến trước paid vẫn có thể decrement khi item chưa tồn tại rồi paid tạo lại full quantity.
- `customers/data_request` mới xác thực, log metadata không PII và ACK. Quy trình xuất/giao dữ liệu cho store owner và durable operator notification chưa được thiết kế.
- Cancel và refund của cùng order hiện là hai event claim độc lập. Nếu Shopify phát cả hai cho cùng quantity, mô hình chưa có per-order contribution để ngăn double-decrement chính xác trong mọi thứ tự delivery.
- Privacy deletion đã bounded concurrency và mỗi delete thành công được lưu bền trên Shopify, nhưng customer có rất nhiều record vẫn có thể vượt request timeout; cần benchmark staging để quyết định có cần durable continuation hay không.
- Sau redaction chưa có privacy-safe durable tombstone; commerce webhook hợp lệ đến muộn/replay vẫn có thể tạo lại claim/item. Không được giữ raw customer ID chỉ để làm tombstone nếu chưa có quyết định privacy/legal.

### 5.2 Historical Batch Sync (async model)
```
POST /api/collection/sync → queue.scheduleJob(customerId)
    → scheduleJob(customer): syncing ngay hoặc FIFO queued; duplicate cùng customer dùng chung lifecycle
    → registerBackgroundTask(completion) qua Vercel waitUntil
    → trả HTTP 202 kèm status syncing/queued
    → background: query orders bằng numeric customer_id (lookback + max 200)
    → loadHistoricalOrderLineItems(order): phân trang line items khi order > 250 items; kiểm tra lặp cursor; giới hạn ORDER_LINE_ITEM_MAX_PAGES = 40 (tối đa 10,000 items/order)
    → lỗi phân trang line items sẽ cô lập order đó (không claim dedup lock) để có thể retry sau mà không mất data
    → nếu toàn bộ orders đã claim từ trước (claimedCoins = 0 và failed = 0), tự động tính lại stats để phục hồi cache nếu run trước crash
    → fetch collectible prerequisites theo alias chunks 25, tối đa 5 queries đồng thời, trước khi tạo dedup claim
    → claim orders theo chunk concurrency 5
    → filterCoinLineItems() → upsert từng product bằng variables theo chunk concurrency 5
    → update sync_progress Customer Metafield; processed/total đo tổng bước claim-order + upsert-product
    → FE phải polling /api/collection.stats đến completed/failed (triển khai và kiểm thử ở Batch F)
```

### 5.3 Manual CRUD
```
Shopify App Proxy ký từng request tới `/api/collection*`
    → authenticateAppProxyRequest() verify signature + timestamp
    → đối chiếu signed shop với SHOPIFY_SHOP_DOMAIN
    → lấy customer_id đã ký; direct Vercel requests bị từ chối 401
    → FE sinh idempotency_key (UUID mới mỗi lần mở form)
    → POST /api/collection { ..., idempotency_key }
    → check cache key = customer + operation + resource + idempotency_key
    → validate với Zod schema
    → metaobject.server.ts CRUD
    → mutation fail: release processing claim rồi rethrow để cùng request retry được
    → mutation success: cache exact result
    → recalculateAndCacheStats() (phân trang metaobjects, chấp nhận nullable optional fields từ Shopify, validate customer_id/is_deleted từng node, parse strict decimal, cursor advance guard)
```

---

## 6. Rate Limiting Strategy

**Reactive**: HTTP 429 hoặc extension THROTTLED → delay `GRAPHQL_RETRY_BASE_DELAY_MS * 2^attempt`, tối đa `GRAPHQL_MAX_RETRY_ATTEMPTS`.

**Proactive**: Sau mỗi response, kiểm tra `extensions.cost.throttleStatus.currentlyAvailable`. Nếu < `actualQueryCost * 2`, sleep để bucket hồi điểm.

**Cross-customer throttle**: `ACTIVE_BATCH_SYNC_JOBS` in-memory counter. Job vượt `MAX_CONCURRENT_BATCH_SYNC_JOBS` → status 'queued', không reject.

Queue hiện giữ FIFO callback và tự start queued job khi slot được release; test chứng minh toàn bộ vòng đời dispatch → queued → start → completion. Đây vẫn là state cấp-instance: nhiều Vercel instance không chia sẻ counter, queue hoặc duplicate-customer key.

`waitUntil()` ngăn fire-and-forget bị freeze ngay sau HTTP response, nhưng background task vẫn bị giới hạn bởi maximum function duration của Vercel. Batch tối đa hoặc upstream chậm cần benchmark staging; vượt timeout cần durable external continuation, ngoài kiến trúc in-memory hiện tại.

**Product upsert concurrency**: read-modify-write được serialize theo `customer_id + product_id` trong một server instance. Vì Vercel có nhiều instance và kiến trúc không có distributed lock/DB, concurrent upserts trên hai instance vẫn là residual risk cần verify trên dev store và quyết định riêng trước production.

**Webhook mutation concurrency**: paid, cancellation, refund và privacy deletion chạy qua `mapSettledInChunks()` với `WEBHOOK_MUTATION_CONCURRENCY = 5`; lỗi từng item được cô lập nhưng không tạo burst tối đa 250 mutation đồng thời.

---

## 7. Security

- Mọi customer API route và dashboard App Proxy phải gọi `authenticateAppProxyRequest()` trước khi đọc hoặc ghi dữ liệu. Không route nào được tự lấy `logged_in_customer_id` từ request chưa xác thực.
- App Proxy identity parameters (`signature`, `shop`, `path_prefix`, `logged_in_customer_id`, `timestamp`) chỉ được xuất hiện đúng một lần. Signed timestamp chỉ hợp lệ trong cửa sổ ±5 phút để giảm replay risk.
- Direct requests tới Vercel customer APIs không có Shopify signature trả HTTP 401.
- Signed request từ shop khác cũng trả HTTP 401 vì Admin token hiện tại chỉ thuộc một `SHOPIFY_SHOP_DOMAIN` cố định.
- Manual idempotency cache luôn scope theo authenticated customer và operation/resource, tránh cached-response leak khi hai customer gửi cùng client UUID.
- Không log full App Proxy URL hoặc query parameters vì chúng chứa reusable signature.
- Mọi Webhook request phải qua HMAC verify trên raw body trước bất kỳ xử lý nào.
- Webhook chỉ được parse sau khi signed shop trùng `SHOPIFY_SHOP_DOMAIN` và `X-Shopify-Topic` trùng route.
- `customers/redact` hard-delete Metaobject thay vì soft-delete; soft-deleted collection items và `collection_dedup_lock` chứa customer/order ID đều nằm trong tập redaction.
- Customer data isolation: filter server-side bằng customer_id trong GraphQL query. Defense-in-depth: `mapMetaobjectToItem()` giữ customer_id, tầng application verify lại.
- Mọi field dùng trong Metaobject search (`customer_id`, `product_id`, `is_deleted`, `in_wishlist`) phải bật `adminFilterable`; setup script migrate definition cũ và chạy real query probe.
- Không string-interpolate user input vào GraphQL — luôn dùng `variables`.

---

## 8. Thay Đổi Kiến Trúc (Changelog)

| Ngày | Thay đổi | Lý do |
|---|---|---|
| 2026-09-04 | Scaffold React Router v7 + Phase 1 files | Khởi tạo project |
| 2026-09-04 | Batch sync → async model (progress polling) | Tránh timeout margin mỏng của sync model (spec mục 4.5 + 11) |
| 2026-09-05 | Centralized App Proxy authentication for every customer route, with duplicate-identity rejection and timestamp freshness | Close direct-backend customer impersonation and signed-request replay risks |
| 2026-09-05 | Bound App Proxy shop identity and scoped manual idempotency cache by customer/operation/resource | Close independent-review blockers for cross-shop authorization and cross-customer cached responses |
| 2026-09-05 | Added mutation failure retry lifecycle, strict Shopify mutation-result validation, quantity boundaries, and same-instance product-upsert serialization | Prevent stuck manual requests, false-success responses, invalid quantities, and local lost updates |
| 2026-09-05 | Centralized webhook authentication, added TOML subscriptions, refund order lookup, cancellation ordering guard, and GDPR hard-delete | Align webhook delivery identity, lifecycle, and privacy behavior with Shopify contracts |
| 2026-09-05 | Bounded webhook mutation concurrency, privacy deletion for dedup locks, Admin API `2026-07`, and `read_all_orders` scope | Close independent-review blockers for privacy completeness, request bursts, and old-order refund lookup |
| 2026-09-05 | Corrected Metaobject field-search syntax and migrated searched fields to `adminFilterable` | Prevent mocked tests from hiding broken customer/product filters and incomplete privacy erasure on Shopify |
| 2026-09-06 | Replaced batch counter-only queue with FIFO lifecycle scheduling, duplicate-customer coalescing, and Vercel `waitUntil` registration | Ensure queued jobs actually start and attach background work to the serverless invocation |
| 2026-09-06 | Deferred batch order claims until collectible lookup succeeds and normalized order customer search to numeric ID | Avoid permanent claims on prerequisite failure and make Shopify order search contract valid |


## 9. Audit E/F/G implementation boundaries

The active storefront renderer is `app/lib/dashboard-html.server.ts`, shared by the root and App Proxy page routes. It renders collection values through DOM `textContent`, serializes server values for inline-script context, and sends requests through the same-origin Shopify proxy path. Shopify signs each forwarded request; the browser does not copy the initial signed query string. Add/Edit uses a fresh UUID per form opening and disables submission immediately. Queued/running sync states poll cached metafields until a terminal state or a bounded polling limit. Dialog focus, keyboard handling, and separate mutation/refresh errors belong to this renderer. Existing React components remain reference implementations, not the active route UI.

The Admin GraphQL client validates response envelopes before returning data. Missing/null top-level data without execution errors is an infrastructure error. HTTP 429 and wholly rejected THROTTLED responses retry within the configured limit; ambiguous mutation network failures and partial-data execution errors do not replay writes. Schema provisioning uses the shared client and rejects unexpected or mixed definition errors and missing success nodes instead of reporting successful setup.

`config/constants.ts` now owns customer/product namespaces (including the catalog fallback), product classification lists, stats and line-item page sizes, schema inventory size, and placeholder integration delays. Runtime reads and explicit setup import the same namespace definitions. Namespace changes do not migrate existing records automatically. Historical line-item pagination beyond 250 items per order (AUD-035) is implemented in `loadHistoricalOrderLineItems()`, and collection stats calculation (`recalculateAndCacheStats`) enforces strict customer ownership, active status, decimal parsing, and cursor pagination loop checks before updating cached metafields.

Yotpo/Klaviyo still log mock outcomes only; their environment placeholders are not runtime credentials. `SHOPIFY_CLIENT_ID` and `APP_HOST` are operator references and are not consumed by the application. Actual proxy/callback configuration lives in Shopify configuration. Required runtime values are `SHOPIFY_APP_SECRET`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_SHOP_DOMAIN`. Build performs no schema mutation. Tests now fail when no test files are discovered.

| Date | Change | Reason |
|---|---|---|
| 2026-09-07 | Completed GraphQL/setup failure classification and shared storefront error handling | Prevent false successful setup, unsafe replay, and lost UI errors |
| 2026-09-07 | Centralized shared namespace/classification configuration and replaced template README/env guidance | Prevent setup/runtime drift and inaccurate owner handover |
| 2026-09-08 | Added historical order line-item continuation pagination (AUD-035) and collection stats cache integrity hardening | Prevent silent order truncation for large orders and protect cached aggregate stats against malformed or cross-customer items |

See `docs/audit/staging-verification.md` for remaining Shopify, serverless, privacy, and human verification gates. No live schema migration or deployment is implied by local verification.
