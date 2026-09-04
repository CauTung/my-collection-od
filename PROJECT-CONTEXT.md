# PROJECT-CONTEXT.md — Downies "My Collection"

> File này chứa bối cảnh nghiệp vụ, spec kỹ thuật và kế hoạch triển khai. Quy tắc code/kỹ thuật bắt buộc nằm ở `AGENTS.md` — đọc cả 2 file trước khi code.

---

## 1. Bối cảnh & mục tiêu

Downies là nhà bán lẻ numismatic (tiền xu, huy chương sưu tầm) vận hành trên **Shopify Plus**. Tính năng **"My Collection"** cho phép nhà sưu tầm theo dõi, quản lý và ghi nhận giá trị bộ sưu tập coin cá nhân — tăng retention, tạo điểm chạm cross-sell, tích hợp loyalty.

**Quy mô**: 500–5,000+ collector khi launch, 20,000+ trong 12 tháng. Bộ sưu tập tối đa ~1,000 items/user.

---

## 2. Stack & kiến trúc bắt buộc

- **Framework**: Remix / React Router v7, TypeScript, Node.js.
- **Hosting**: Serverless (Vercel hoặc AWS App Runner) — Downies đứng tên & thanh toán tài khoản.
- **Data layer**: 100% Shopify Native — Metaobjects + Customer/Product Metafields. **Không Redis, không database bên thứ 3**, kể cả cho cache hay lock.
- **Auth**: Shopify App Proxy + HMAC-SHA256 (dùng `SHOPIFY_APP_SECRET`). Admin GraphQL dùng access token riêng (`SHOPIFY_ADMIN_ACCESS_TOKEN`) — 2 secret khác nhau, không dùng lẫn.
- **Rate limiting**: Cost-based leaky bucket (5,000 pts capacity, 50 pts/giây leak rate). Cần Query Cost Calculator + Exponential Backoff cho `THROTTLED`/429, cộng thêm proactive throttling (chủ động giãn tốc độ khi budget còn thấp, không chỉ phản ứng sau khi bị từ chối).

---

## 3. Data Schema

### Metaobject `collection_item`
| Field | Type | Ghi chú |
|---|---|---|
| `item_id` | Text | UUID v4, immutable |
| `product_id` | Text | `gid://shopify/Product/...` |
| `sku_code` | Text | Mapping ERP sau này (không dùng ở MVP) |
| `source` | Text | `shopify_sync` \| `erp_sync` \| `manual_entry` |
| `external_order_id` | Text | Dùng để dedup |
| `customer_id` | Text | **Bắt buộc lưu và giữ lại khi map dữ liệu trả về** — dùng để tự kiểm tra cách ly dữ liệu |
| `quantity_owned` | Integer | ≥1, max 999 |
| `date_added_to_collection` | Date | Auto-set |
| `purchase_date` | Date | |
| `purchase_price` | Decimal | |
| `current_market_value` | Decimal | **Giá trị user tự nhập — KHÔNG phải giá thị trường tự động** |
| `certificate_number` | Text | Max 50 chars |
| `user_grade` | Text | Max 200 chars |
| `user_notes` | Multi-line text | Max 500 chars |
| `in_wishlist` | Boolean | |
| `is_deleted` | Boolean | Soft delete |

### Metaobject riêng cho dedup lock (khuyến nghị tách khỏi `collection_item`)
Type riêng, handle `dedup-{customer_id}-{order_id}`, chỉ chứa `customer_id` + `external_order_id`. Tách riêng để `collection_item` không phải gánh 2 vai trò (dữ liệu + lock).

### Customer Metafield `my_collection`
`total_items` (Integer, cached), `total_value` (Decimal, cached Σ), `created_at` (Date), `last_updated` (Timestamp).

### Product Metafield `collectible_data`
`erp_sku`, `denomination`, `country_of_issue`, `material`, `year_of_issue`, `issuer`, `quality`, `grade`, `limited_mintage`, `mintage_limit`.

**Trước khi tạo namespace**: verify `my_collection`/`collectible_data` không xung đột với app hiện tại trên Shopify Admin. Fallback: `downies_collection`/`downies_product_data`.

---

## 4. Business Rules — Logic đồng bộ dữ liệu

### 4.1 Real-time sync (webhook `orders/paid`)
1. Verify HMAC.
2. Dedup: `claimOrderSync()` atomic — nếu order đã claim, early-return `200 OK`, không xử lý tiếp.
3. Fetch `collectible_data` metafield cho các `product_id` trong line items → build set `collectibleProductIds`.
4. Filter line items: giữ lại sản phẩm có metafield `collectible_data` **HOẶC** `productType` khớp danh sách numismatic đã định nghĩa; loại bỏ phụ kiện (case, cleaning kit, storage box, album, postage).
5. **Upsert theo `product_id`** (không phải luôn tạo mới): nếu customer đã có item cùng `product_id`, tăng `quantity_owned += lineItem.quantity`; nếu chưa có, tạo record mới.
6. Recalculate `total_items`/`total_value` → cache vào Customer Metafields.
7. Lần đầu tạo collection → gọi Yotpo cộng 50 điểm (non-blocking, không fail webhook nếu Yotpo lỗi).

### 4.2 Order lifecycle — cancel/refund
- Webhook `orders/cancelled`: huỷ toàn bộ → soft-delete item tương ứng; huỷ một phần → giảm `quantity_owned`.
- Webhook `refunds/create`: trừ đúng số lượng coin bị refund, tính lại cached stats.

### 4.3 GDPR Mandatory Webhooks
Bắt buộc implement đủ: `customers/data_request`, `customers/redact`, `shop/redact` — không để TODO, phải thực sự xử lý export/redact dữ liệu.

### 4.4 Historical Batch Sync
- Trigger: user bấm "Sync Past Purchases" lần đầu.
- **Giới hạn**: tối đa **3 năm gần nhất** (`createdAt >= now - 3 years`) HOẶC tối đa **200 đơn hàng/customer**, tuỳ điều kiện nào đến trước.
- Banner UX khi chạm trần: *"Hệ thống đã tự động đồng bộ các đơn hàng trong 3 năm gần nhất (tối đa 200 đơn). Đối với các đồng xu mua trước thời gian này, quý khách vui lòng thêm thủ công qua biểu mẫu Thêm đồng xu mới."*
- Tối ưu hiệu năng: gộp nhiều mutation vào 1 HTTP payload bằng GraphQL alias (giảm round-trip) + concurrency giữa các order/payload (không chỉ trong 1 order) + proactive rate limiting.
- **Khuyến nghị kiến trúc**: chuyển sang mô hình async (trả về ngay trạng thái "đang đồng bộ", xử lý nền, FE polling tiến độ qua 1 Customer Metafield tạm) thay vì cố nhồi toàn bộ 200 đơn vào 1 request-response đồng bộ trong giới hạn timeout App Proxy (~10s) — vì ngay cả sau tối ưu, thời gian chạy thực tế (tính cả throttle retry) vẫn dao động sát ngưỡng timeout, margin an toàn mỏng.

### 4.5 ERP-Ready nhưng KHÔNG thực thi trong MVP
Schema có sẵn field cho ERP (`sku_code`, `source: erp_sync`) nhưng không code endpoint ERP thật trong scope này.

---

## 5. API Endpoints

| Method | Endpoint | Ghi chú |
|---|---|---|
| GET | `/api/collection` | List items, filter theo `customer_id` ở server-side (GraphQL `query` param), có phân trang cursor |
| POST | `/api/collection` | Tạo item thủ công — cần `idempotency_key` chống double-submit |
| PUT | `/api/collection/:item_id` | Update — cần `idempotency_key` |
| DELETE | `/api/collection/:item_id` | Soft delete (`is_deleted=true`) |
| POST | `/api/webhooks/orders-paid` | Real-time sync |
| POST | `/api/webhooks/orders-cancelled` | Auto giảm/xoá item |
| POST | `/api/webhooks/refunds-create` | Auto giảm/xoá item |
| POST | `/api/webhooks/customers-data-request` | GDPR |
| POST | `/api/webhooks/customers-redact` | GDPR |
| POST | `/api/webhooks/shop-redact` | GDPR |
| POST | `/api/collection/sync` | Trigger historical batch sync |

---

## 6. Frontend

Dashboard "My Collection" — stats cards, grid/list view (AJAX, pagination/lazy-load), filter/sort (denomination, country, material, year, grade, issuer — giữ state qua URL params), modal Add/Edit (validation đầy đủ), delete flow (double confirm), responsive, WCAG 2.1 AA best-effort. Banner UX cho lookback limit (mục 4.4).

---

## 7. Ràng buộc & giả định KHÔNG được tự ý đổi

1. Dữ liệu đơn hàng 100% từ Shopify GraphQL API — không phải ERP.
2. `current_market_value` là giá trị user tự nhập — không tích hợp pricing API/AI bên thứ 3.
3. Wishlist vendor: TBD — dùng Interface Adapter Pattern, hiện dùng `NullWishlistAdapter` no-op, không block phần còn lại.
4. Không dùng Redis/DB ngoài dưới bất kỳ hình thức nào.
5. Ngoài phạm vi: ERP active sync, mobile app riêng, auto market valuation, P2P marketplace, xác thực PCGS/NGC, bảo hiểm, đa tiền tệ, xuất PDF.

---

## 8. Constants cần tập trung tại `app-shopify/app/config/constants.ts`

| Constant | Giá trị |
|---|---|
| `HISTORICAL_SYNC_LOOKBACK_YEARS` | 3 |
| `HISTORICAL_SYNC_MAX_ORDERS` | 200 |
| `MAX_QUANTITY_OWNED` | 999 |
| `MAX_CERTIFICATE_NUMBER_LENGTH` | 50 |
| `MAX_USER_GRADE_LENGTH` | 200 |
| `MAX_USER_NOTES_LENGTH` | 500 |
| `LOYALTY_SIGNUP_BONUS_POINTS` | 50 |
| `APP_PROXY_RATE_LIMIT_PER_MINUTE` | 60 |
| `GRAPHQL_BUCKET_CAPACITY` | 5000 |
| `GRAPHQL_LEAK_RATE_PER_SECOND` | 50 |
| `GRAPHQL_RETRY_BASE_DELAY_MS` | 500 |
| `GRAPHQL_MAX_RETRY_ATTEMPTS` | 5 |
| `BATCH_SYNC_CONCURRENCY` | 5 |
| `MAX_CONCURRENT_BATCH_SYNC_JOBS` | 10 |
| `COLLECTION_PAGE_SIZE` | 50 |

Không hardcode số nào ngoài file này (chi tiết yêu cầu ở `AGENTS.md` mục 1).

---

## 9. Kế hoạch triển khai (theo thứ tự)

1. Tạo `AGENTS.md` + đọc `PROJECT-CONTEXT.md` (file này).
2. Setup constants (`app-shopify/app/config/constants.ts`) trước mọi module khác.
3. Setup `.env.example` — đủ biến, tách rõ `SHOPIFY_APP_SECRET` vs `SHOPIFY_ADMIN_ACCESS_TOKEN`.
4. Backend: HMAC middleware → GraphQL client (retry/backoff/proactive throttle) → dedup engine → metaobject CRUD → webhook handlers → historical batch sync.
5. Frontend: dashboard → CRUD forms → filters → wishlist adapter (null impl).
6. Integrations: Yotpo, Klaviyo, Wishlist adapter.
7. Testing: unit test cho các phần dễ sai nhất (dedup, product-filter, stats, batch-sync boundary, HMAC, CRUD idempotency, customer isolation).
8. Chạy đủ 4 lệnh verify (`typecheck`, `test`, `lint`, `build`) — xem `AGENTS.md` mục 4.
9. **Đưa code cho reviewer độc lập** (người khác hoặc AI khác, không phải chính AI vừa code) trước khi coi là hoàn thành — đây là bước bắt buộc, không phải tuỳ chọn.
10. Staging verification trên Shopify dev store thật trước go-live.

---

## 10. Open Questions cần Downies xác nhận (Tuần 1)

| # | Câu hỏi | Deadline | Mặc định nếu trễ |
|---|---|---|---|
| 1 | Data source: Shopify hay ERP? | Ngày 2 | Shopify; ERP là CR riêng |
| 2 | Wishlist vendor cụ thể? | Ngày 3 | Ẩn UI Wishlist, bổ sung sau |
| 3 | Staging keys Yotpo/Klaviyo? | Ngày 3 | Dùng mock services |
| 4 | Namespace collision check | Ngày 1 (bắt buộc trước khi code) | Fallback `downies_collection`/`downies_product_data` |
| 5 | Delete: hard hay soft? | Ngày 2 | Soft delete |
| 6 | Hosting platform? | Ngày 4 | Vercel/AWS App Runner |
| 7 | Downies đứng tên hosting account? | Ngày 4 | Dev hỗ trợ tạo, chuyển owner trước go-live |
