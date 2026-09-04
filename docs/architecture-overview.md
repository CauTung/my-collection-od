# Architecture Overview — Downies "My Collection"

> **BẮTBUỘC CẬP NHẬT** mỗi khi có thay đổi về cấu trúc thư mục, luồng dữ liệu, exception handling hoặc performance optimization. Xem AGENTS.md mục 5.

**Phiên bản**: 0.1.0 (Phase 1 Setup)
**Cập nhật lần cuối**: 2026-09-04
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
| `hmac.server.ts` | Verify HMAC — App Proxy (query params) + Webhook (raw body) |
| `session.server.ts` | Extract customer_id từ App Proxy request |
| `graphql-client.server.ts` | Wrapper duy nhất cho Admin GraphQL — retry/backoff/proactive throttle |
| `dedup.server.ts` | claimOrderSync() atomic — metaobjectCreate + catch userErrors |
| `metaobject.server.ts` | CRUD collection_item — nơi DUY NHẤT gọi GraphQL cho type này |
| `metafield.server.ts` | CRUD Customer/Product Metafields |
| `stats.server.ts` | recalculateAndCacheStats() — sau mỗi CRUD |
| `product-filter.server.ts` | filterCoinLineItems() — coin vs accessory classifier |
| `batch-sync.server.ts` | Historical Batch Sync engine (async model, progress polling) |
| `idempotency.server.ts` | Cache idempotency_key cho CRUD manual |
| `queue.server.ts` | ACTIVE_BATCH_SYNC_JOBS in-memory counter |
| `error-handler.server.ts` | AppError class + withErrorHandler() wrapper |
| `logger.server.ts` | Structured JSON logger, auto-redact PII |

---

## 5. Luồng Dữ Liệu

### 5.1 Real-time Webhook (orders/paid)
```
Shopify → HMAC verify → claimOrderSync() (atomic)
    → fetch collectible_data metafields → filterCoinLineItems(lineItems, collectibleProductIds)
    → upsert collection_item theo product_id (không luôn tạo mới)
    → recalculateAndCacheStats()
    → Yotpo +50pts (non-blocking, lần đầu tạo collection)
```

### 5.2 Historical Batch Sync (async model)
```
POST /api/collection/sync → queue.canStartNewJob()
    → trả về { status: 'syncing' } ngay
    → background: query orders (lookback + max filter)
    → filterCoinLineItems() → chunked Promise.allSettled()
    → GraphQL alias batch mutations (variables, cost-aware)
    → update sync_progress Customer Metafield
    → FE polling /api/collection.stats để xem tiến độ
```

### 5.3 Manual CRUD
```
FE sinh idempotency_key (UUID mới mỗi lần mở form)
    → POST /api/collection { ..., idempotency_key }
    → check idempotency cache
    → validate với Zod schema
    → metaobject.server.ts CRUD
    → recalculateAndCacheStats()
```

---

## 6. Rate Limiting Strategy

**Reactive**: HTTP 429 hoặc extension THROTTLED → delay `GRAPHQL_RETRY_BASE_DELAY_MS * 2^attempt`, tối đa `GRAPHQL_MAX_RETRY_ATTEMPTS`.

**Proactive**: Sau mỗi response, kiểm tra `extensions.cost.throttleStatus.currentlyAvailable`. Nếu < `actualQueryCost * 2`, sleep để bucket hồi điểm.

**Cross-customer throttle**: `ACTIVE_BATCH_SYNC_JOBS` in-memory counter. Job vượt `MAX_CONCURRENT_BATCH_SYNC_JOBS` → status 'queued', không reject.

---

## 7. Security

- Mọi App Proxy + Webhook request phải qua HMAC verify trước bất kỳ xử lý nào.
- Customer data isolation: filter server-side bằng customer_id trong GraphQL query. Defense-in-depth: `mapMetaobjectToItem()` giữ customer_id, tầng application verify lại.
- Không string-interpolate user input vào GraphQL — luôn dùng `variables`.

---

## 8. Thay Đổi Kiến Trúc (Changelog)

| Ngày | Thay đổi | Lý do |
|---|---|---|
| 2026-09-04 | Scaffold React Router v7 + Phase 1 files | Khởi tạo project |
| 2026-09-04 | Batch sync → async model (progress polling) | Tránh timeout margin mỏng của sync model (spec mục 4.5 + 11) |
