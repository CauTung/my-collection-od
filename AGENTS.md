# AGENTS.md — Developer & AI Agent Guidelines

> **PROJECT**: Downies — My Collection (Shopify Plus App)
> **SCOPE BOUNDARY**: MVP Scope (theo `tech-lead-spec.md`)
> **ARCHITECTURE**: Shopify Native Data Layer (Metaobjects & Metafields — 0 External DB)

Tài liệu này định nghĩa các **nguyên tắc bắt buộc (Mandatory Rules)** cho tất cả AI Agents và Developers làm việc trong codebase này. Mọi Pull Request hoặc Code Edit đều phải tuân thủ 100% các quy định dưới đây.

---

## 🛑 1. Bám Sát Phạm Vi Scope & Không Phình Tính Năng (Strict Scope Control)

1. **No Unrequested Features (YAGNI)**:
   - Không tự ý thêm tính năng mới không có trong `tech-lead-spec.md` hoặc `wbs-et-breakdown.md`.
   - Không tự tiện bổ sung UI components/fields trừ khi người dùng hoặc spec yêu cầu.
2. **Không Tự Viết Helper/Utility Trùng Lặp**:
   - Mọi numeric limits, thresholds, timeouts, API endpoints phải lấy từ `app-shopify/app/config/constants.ts`.
   - Tuyệt đối không hardcode string/number trong các file logic business hoặc UI components.
3. **Refactor Có Mục Đích Rõ Ràng**:
   - Mọi refactoring phải phục vụ trực tiếp cho mục tiêu hiệu năng (performance), tính ổn định (resilience/exception) hoặc fix bug.
   - Nếu 1 thay đổi làm phát sinh phạm vi ngoài spec đã chốt (thêm endpoint, thêm module, thêm integration), **phải dừng lại và báo cáo trước khi code tiếp** — không tự quyết định âm thầm rồi ghi vào changelog sau.

---

## ⚡ 2. Quy Định Nghiêm Ngặt Về Hiệu Năng (Performance Guidelines)

1. **O(1) Native Handle Lookup**:
   - Khi kiểm tra trùng lặp (dedup) hoặc tìm kiếm Metaobject theo ID, **bắt buộc** dùng `metaobjectByHandle(handle: ...)` với handle chuẩn hóa:
     - Deduplication: `dedup-{customer_id}-{order_id}`
     - Collection Item: `{customer_id}-{item_id}`
   - **Cấm**: Không được sử dụng GraphQL queries dạng `metaobjects(first: 250)` rồi filter mảng trên client ngoại trừ trang liệt kê phân trang.
2. **Parallel Concurrency Control cho Batch Processing**:
   - Khi xử lý mảng items lớn (như Batch Sync 200 đơn hàng), **bắt buộc** dùng `Promise.allSettled()` theo dạng **Chunking Concurrency** (với `BATCH_SYNC_CONCURRENCY = 5`).
   - **Cấm**: Không dùng vòng lặp `for...of` với `await` từng item đơn lẻ (N+1 Sequential Execution).
3. **System-Wide Concurrent Job Limit (Cross-Customer Throttling)**:
   - `BATCH_SYNC_CONCURRENCY = 5` chỉ giới hạn concurrency **trong 1 job** của 1 customer. Việc này **không** ngăn được trường hợp nhiều customer cùng bấm "Sync Past Purchases" trong cùng thời điểm (thực tế dễ xảy ra ở giờ đầu ra mắt tính năng), khiến tổng số GraphQL call cộng dồn vượt Leaky Bucket của toàn shop.
   - **Bắt buộc**: duy trì 1 bộ đếm toàn hệ thống `ACTIVE_BATCH_SYNC_JOBS` (in-memory counter theo process, không cần Redis) giới hạn bởi `MAX_CONCURRENT_BATCH_SYNC_JOBS` (constant trong `app-shopify/app/config/constants.ts`, giá trị mặc định đề xuất: `10`).
   - Khi vượt ngưỡng, job Sync mới phải trả về trạng thái "đang chờ" (queued) cho FE hiển thị, **không** được từ chối thẳng hoặc để GraphQL tự bắn 429 không kiểm soát.
   - Vì kiến trúc là serverless (nhiều instance song song), bộ đếm in-memory chỉ là chắn chắn cấp-instance — không phải chắn tuyệt đối toàn hệ thống. Đây là trade-off được chấp nhận trong phạm vi 170h (đổi lấy việc không cần thêm Redis/DB ngoài); nếu sau launch phát hiện throttling thực tế do concurrent syncs, cân nhắc bổ sung hàng đợi thật (Phase 2, ngoài 170h hiện tại).
4. **Aggregate Stats Caching**:
   - `total_items` và `total_value` của collector bắt buộc phải đọc từ Cached Customer Metafields (`my_collection.total_items`).
   - Không scan toàn bộ Metaobjects khi render Dashboard header/stats.

---

## 🛡️ 3. Xử Lý Ngoại Lệ & Độ Tin Cậy (Exception Handling & Resilience)

1. **Graceful Atomic Race-Condition Handling (Webhook & Batch Sync)**:
   - Khi gọi `metaobjectCreate`, phải chủ động bắt lỗi native `userErrors` có thông điệp `taken` hoặc `already` (trùng handle do race condition Webhooks/Sync) ➔ Nuốt lỗi, log warning và trả về kết quả hợp lệ đại diện cho 200 OK. Tuyệt đối không để throw ra lỗi HTTP 500.
2. **CRUD Idempotency — Chống Double-Submit từ UI (Manual Add/Edit)**:
   - Rule ở mục 3.1 chỉ bao phủ webhook và batch sync (server-to-server). **Route manual entry (`POST /api/collection`, `PUT /api/collection/:item_id`) cũng phải được bảo vệ riêng**, vì đây là nơi user bấm nút qua UI — dễ xảy ra double-click hoặc double-submit do mạng chậm.
   - **Bắt buộc**: FE sinh 1 `idempotency_key` (UUID) duy nhất mỗi lần mở form Add/Edit, gửi kèm trong request body. Backend kiểm tra key này (lưu tạm trong Metaobject field ẩn hoặc theo cơ chế cache ngắn hạn cấp-instance) — nếu key đã được xử lý, trả về kết quả cũ thay vì tạo/sửa lần 2.
   - Nút Submit trên FE phải tự disable ngay sau lần bấm đầu tiên (client-side debounce) như lớp phòng thủ đầu tiên, độc lập với idempotency key ở backend.
3. **Exception Isolation trong Batch Jobs**:
   - Trong các vòng lặp xử lý danh sách (Batch Sync / Webhook processing), từng item phải được bọc trong `try/catch` hoặc `Promise.allSettled()`. Lỗi của 1 item bất kỳ phải được log riêng và **không được phép làm dừng hoặc hủy bỏ toàn bộ đợt xử lý của các items khác**.
4. **Shopify Leaky Bucket & Exponential Backoff**:
   - Mọi lời gọi Admin GraphQL API phải đi qua `shopifyGraphQL()` trong `app-shopify/app/lib/graphql-client.server.ts`.
   - Khi gặp HTTP 429 hoặc extension `THROTTLED`, client phải tự động delay theo công thức `GRAPHQL_RETRY_BASE_DELAY_MS * 2^attempt` (tối đa `GRAPHQL_MAX_RETRY_ATTEMPTS = 5`).

---

## 🧪 4. Quy Định Kiểm Thử & Chạy Build (Verification & Testing Protocol)

Mỗi khi chỉnh sửa hoặc refactor code, **bắt buộc phải thực hiện ĐỦ 4 lệnh kiểm tra sau, không được dừng ở 2 lệnh đầu**:

```bash
# 1. Typecheck toàn bộ dự án
npm run typecheck

# 2. Chạy toàn bộ bộ test suite
npm test

# 3. Lint — bắt buộc, không được bỏ qua dù dự án chưa có nhiều rule
npm run lint

# 4. Build thật — bắt buộc, vì typecheck/test pass KHÔNG chứng minh app build/deploy được
npm run build
```

- Khi báo cáo hoàn thành 1 task, **dán nguyên văn output của cả 4 lệnh**, không tóm tắt bằng lời ("đã pass hết"), không chỉ báo 2 lệnh đầu rồi bỏ qua lint/build.
- Tất cả unit test files mới phải viết bằng TypeScript (`.ts`) trong thư mục `app-shopify/tests/unit/`.
- Module bảo mật HMAC (`app-shopify/app/lib/hmac.server.ts`) phải luôn có bộ test vây quanh 100%.
- Module idempotency cho CRUD manual (mục 3.2) phải có test riêng: double-submit cùng `idempotency_key` chỉ tạo/sửa 1 lần duy nhất.
- **Test phải assert số liệu cụ thể, không dùng assertion lỏng.** Ví dụ: nếu test concurrency, phải assert khoảng chặt (`>= 4 và <= 5`), không chỉ `<= 5` (vì `1 <= 5` vẫn pass dù concurrency thực tế là 1, tức đang chạy tuần tự chứ không song song — đây là lỗi thật đã từng xảy ra).
- **Mock không thay thế được test trên môi trường thật.** Trước khi báo 1 tính năng liên quan tới Shopify Admin GraphQL là "hoàn thành", phải nêu rõ: đây là kết quả từ mock hay đã chạy trên Shopify dev store thật. Nếu chỉ là mock, phải ghi rõ "CẦN VERIFY TRÊN DEV STORE THẬT TRƯỚC KHI COI LÀ XONG".
- Không dùng try/catch để nuốt lỗi rồi báo test pass — nếu 1 nhánh logic có khả năng throw, phải có test cố tình kích hoạt nhánh đó và assert đúng hành vi, không chỉ assert "không crash".

---

## ⚠️ 4.5. Known Pitfalls — Lỗi Đã Từng Xảy Ra Ở Lần Build Trước (PHẢI ĐỌC TRƯỚC KHI CODE)

Dự án này đã từng được build 1 lần và bị phát hiện hàng loạt lỗi qua review độc lập. Codebase cũ đã mất, nhưng các lỗi dưới đây **rất dễ lặp lại** nếu không được nhắc trước. Khi code lại từ đầu, chủ động tránh các lỗi sau — không đợi bị phát hiện lại:

1. **Admin API Auth**: Phải dùng biến môi trường riêng `SHOPIFY_ADMIN_ACCESS_TOKEN` (access token thật, lấy qua OAuth) cho mọi request gọi Shopify Admin GraphQL. **Không được dùng `SHOPIFY_APP_SECRET`** cho việc này — secret đó chỉ dùng để verify HMAC (App Proxy + Webhook), là 2 mục đích hoàn toàn khác nhau.
2. **Dedup phải atomic thật, không phải check-rồi-tạo**: Chiến lược đúng là gọi thẳng `metaobjectCreate` với `handle` chuẩn hoá (`dedup-{customer_id}-{order_id}`), rồi bắt lỗi `taken`/`already` trong `userErrors` để phát hiện trùng — không phải query trước (`metaobjectByHandle`) rồi mới quyết định có tạo hay không (kiểu này vẫn có race condition thật).
3. **Webhook `orders/paid` phải upsert theo `product_id`, không phải luôn tạo mới**: Nếu khách hàng mua cùng 1 sản phẩm ở 2 đơn hàng khác nhau, phải tăng `quantity_owned` của item hiện có, không tạo thêm record mới. Đây là lỗi dễ bị bỏ sót nhất vì không có test nào tự nhiên phát hiện ra nếu không cố tình viết test cho đúng kịch bản "2 đơn hàng cùng sản phẩm".
4. **Product filter (`filterCoinLineItems`) phải luôn nhận đúng `collectibleProductIds`**: Hàm nhận diện coin dựa trên "metafield `collectible_data` HOẶC product_type khớp danh sách cứng". Nếu quên fetch metafield trước và truyền vào, hàm sẽ fallback về chỉ nhận diện qua product_type — dễ âm thầm loại bỏ nhầm coin thật nếu catalog Downies đặt tên product_type khác với danh sách cứng trong code. Phải đảm bảo **cả webhook real-time lẫn batch sync** đều gọi đúng, không chỉ 1 trong 2.
5. **Không string-interpolate trực tiếp giá trị user-input vào GraphQL query/mutation string**, kể cả khi dùng kỹ thuật gộp nhiều mutation bằng alias trong 1 payload. Các field tự do nhập bởi user (`user_notes`, `certificate_number`, `user_grade`) có thể chứa dấu `"` hoặc ký tự đặc biệt, gây vỡ cú pháp hoặc GraphQL injection. Luôn dùng `variables`, hoặc escape kỹ nếu bắt buộc phải dùng string template.
6. **Customer data isolation phải test được bằng bằng chứng cụ thể, không chỉ tin code "trông đúng"**: Filter theo `customer_id` trong GraphQL `query` param (cú pháp Shopify Metaobjects search) phải có test tạo 2 customer khác nhau, mỗi người có item riêng, và assert rằng gọi API cho customer A không bao giờ trả về item của customer B. Đồng thời, hàm map dữ liệu (`mapMetaobjectToItem` hoặc tương đương) nên giữ lại field `customer_id` trong object trả về nội bộ, để có thể tự defense-in-depth kiểm tra lại ở tầng application, không chỉ dựa vào 1 lớp filter duy nhất.
7. **Định nghĩa rõ "concurrency" đang đo cái gì trước khi tin số liệu benchmark**: Concurrency giữa nhiều order (nhiều order được xử lý song song) khác với concurrency trong 1 order (nhiều item của cùng 1 order được gộp/xử lý cùng lúc). Một bài test có thể "pass" nhưng đo nhầm đối tượng, khiến số liệu tốc độ trông đẹp nhưng không phản ánh đúng hành vi hệ thống thật.
8. **Lookback boundary (constants cho historical sync) phải đồng bộ ở TẤT CẢ nơi nhắc đến nó** — bao gồm constant, GraphQL query filter, banner UX copy hiển thị cho khách hàng, và test case biên (boundary test). Đổi 1 chỗ mà quên chỗ khác sẽ dẫn đến hệ thống nói 1 đằng làm 1 nẻo.
9. **Test hàng đợi (queue) phải chứng minh vòng đời đầy đủ, không chỉ trạng thái phân loại ban đầu**: Nếu có cơ chế "N job chạy ngay, M job vào hàng chờ" (ví dụ `MAX_CONCURRENT_BATCH_SYNC_JOBS`), test không được dừng lại ở việc assert đúng số lượng job rơi vào mỗi nhóm tại thời điểm dispatch. Phải chứng minh thêm: các job bị queue **sau đó có thực sự được xử lý và hoàn thành** hay không, kèm timestamp completion khác với timestamp dispatch. Một log ghi tất cả entry cùng 1 timestamp là dấu hiệu đáng ngờ — chỉ ghi lại lúc phân loại, không theo dõi lúc hoàn thành.
10. **GraphQL cost của 1 payload gộp N-alias phải tính cộng dồn (N × cost/mutation đơn), không phải tính như 1 mutation đơn lẻ.** Nếu cost calculator trong code undercount, hệ thống sẽ tưởng còn dư ngân sách rate-limit nhưng thực tế đã sát/vượt ngưỡng leaky bucket của Shopify, dẫn tới bị `THROTTLED` bất ngờ trên production dù test/benchmark nội bộ chạy mượt.

---

## 📝 5. Quy Trình Cập Nhật Tài Liệu Kiến Trúc (Documentation Update Protocol)

> **MANDATORY**: Bất kỳ sự thay đổi nào về cấu trúc thư mục, luồng dữ liệu, cách xử lý exception hoặc tối ưu hiệu năng đều **BẮT BUỘC ĐƯỢC CẬP NHẬT NGAY VÀO FILE `docs/architecture-overview.md`**.

### Quy trình 3 bước khi hoàn thành code change:
1. **Code & Test**: Thực hiện code change + chạy `npm run typecheck && npm test` đảm bảo 100% PASS.
2. **Update Doc**: Mở file `docs/architecture-overview.md`, cập nhật lại mô hình/phần liên quan tương ứng với thay đổi mới.
3. **Verify Integrity**: Đảm bảo tài liệu architecture phản ánh **chính xác 100%** trạng thái codebase thực tế hiện tại.

---

## 📐 6. Coding Conventions

### Language — MANDATORY
- **All code, comments, inline documentation, JSDoc, variable names, function names, type names, and test descriptions MUST be written in English. No exceptions.**
- This applies to every file in the codebase: `*.ts`, `*.tsx`, `*.js`, `*.css`, config files, and scripts.
- The only allowed Vietnamese is in `AGENTS.md`, `PROJECT-CONTEXT.md`, `tech-lead-spec.md`, and `docs/architecture-overview.md` (reference/spec documents intended for Vietnamese-speaking stakeholders).
- AI agents generating code must default to English for all output — do not use Vietnamese variable names, comments, or string literals in source code.

### Strict Typing & Linting — MANDATORY
- **Tuyệt đối không sử dụng `/* eslint-disable */` hoặc `@ts-ignore` để bypass các lỗi linter/type-checker liên quan đến strict typing (như `any`, `unsafe-assignment`, `unsafe-member-access`).**
- Mọi dữ liệu trả về từ GraphQL API hoặc các nguồn bên ngoài đều phải được định nghĩa `interface` hoặc `type` cụ thể và ép kiểu rõ ràng, không được dùng `any` để "lười" viết type.
- Linter rules (đã bật type-aware) là chốt chặn an toàn, việc bypass linter đi ngược lại tinh thần "Strict Verification" của dự án.


### Naming
- File: `kebab-case.server.ts` cho server-only modules (Remix quy ước — hậu tố `.server.ts` đảm bảo không bị bundle vào client).
- Function: `camelCase`, động từ rõ nghĩa đầu tiên (`createCollectionItem`, `isOrderAlreadySynced`, `claimOrderSync`) — không đặt tên mơ hồ kiểu `process()`, `handle()`, `doWork()`.
- Constant: `SCREAMING_SNAKE_CASE`, khai báo duy nhất trong `app-shopify/app/config/constants.ts` (mục 1 ở trên).
- Type/Interface: `PascalCase` (`CollectionItem`, `CollectionFilters`) — đặt trong `app-shopify/app/types/`, không định nghĩa lại type trùng tên ở nhiều nơi.

### Cấu trúc 1 module `*.server.ts`
1. Docstring đầu file: mô tả mục đích module + chiến lược/quyết định thiết kế quan trọng (không phải chỉ liệt kê hàm) — xem cách viết trong `dedup.server.ts`, `graphql-client.server.ts` làm mẫu.
2. Import: thư viện ngoài trước, sau đó tới `~/lib/...` nội bộ, sau cùng là `~/types`.
3. Hàm public export ở trên, helper private (không export) ở dưới cùng file nếu chỉ dùng nội bộ module đó.
4. Mỗi hàm public có JSDoc ngắn nêu rõ: input, output, và **điều kiện throw** (nếu có) — đặc biệt quan trọng với các hàm có thể throw `AppError`.

### Error Handling
- Mọi route action/loader bọc qua `withErrorHandler()` (`error-handler.server.ts`) — không tự viết try/catch rời rạc trong từng route.
- Phân biệt rõ 2 loại lỗi: **lỗi nghiệp vụ có mã cụ thể** (`AppError` với `ErrorCode` enum, ví dụ `HMAC_INVALID`) throw để `withErrorHandler` xử lý thành response chuẩn; **lỗi hạ tầng bất ngờ** (network, parse fail) để tự nhiên propagate lên `withErrorHandler` catch chung, không nuốt âm thầm.
- Không dùng try/catch rồi bỏ trống catch block hoặc chỉ `console.log` — mọi catch phải hoặc log qua `logger.server.ts`, hoặc re-throw, hoặc trả về giá trị fallback có ý nghĩa rõ ràng (như cách `claimOrderSync` catch lỗi `taken` để trả `false`).

### GraphQL
- Luôn dùng `variables` cho giá trị động — **không string-interpolate trực tiếp** vào query/mutation string, kể cả khi build payload nhiều-alias (xem `AGENTS.md` Known Pitfalls #5).
- Mọi query/mutation phải đi qua `shopifyGraphQL()` trong `graphql-client.server.ts` — không tự gọi `fetch()` tới Admin API ở nơi khác.
- Đặt tên operation GraphQL rõ ràng (`query GetCollectionItems`, `mutation ClaimOrderSync`) — không để operation không tên, vì code check `query.includes("...")` ở nhiều chỗ (bao gồm cả mock trong test) dựa vào tên này.

### React/Frontend
- Component thuần UI (`components/ui/`) không chứa business logic hay gọi API trực tiếp — nhận data/callback qua props.
- State chia sẻ giữa nhiều component (ví dụ Toast) phải dùng context hoặc store chung — không tạo nhiều instance hook độc lập rồi kỳ vọng chúng đồng bộ với nhau (lỗi đã gặp, xem mục Directory Structure ở `tech-lead-spec.md`, phần `useToast`).
- Data fetching qua Remix loader/action, không dùng `useEffect` + `fetch` thủ công trừ khi thực sự cần (polling tiến độ batch sync là 1 trường hợp hợp lệ).

### Comment
- Comment giải thích **tại sao** (quyết định thiết kế, đánh đổi), không comment lặp lại **cái gì** đã quá rõ từ tên hàm/biến.
- Nếu 1 đoạn code là workaround cho hành vi đặc thù của Shopify (ví dụ: proactive throttle, atomic-create-catch-error), bắt buộc có comment giải thích lý do — người đọc sau (kể cả AI khác) không tự suy ra được nếu không biết bối cảnh.

### Tests
- File test đặt cạnh theo tên module tương ứng (`dedup.server.ts` → `dedup.test.ts`), không gộp nhiều module vào 1 file test lớn.
- Tên test case mô tả hành vi cụ thể bằng câu hoàn chỉnh, không viết tên chung chung (`"works correctly"`, `"handles edge case"`).
- Assertion phải so khớp giá trị cụ thể — xem quy định chi tiết ở mục 4.

---

## 📌 7. Checklist Xác Nhận Trước Khi Merge (Pre-Merge Sanity Check)

Trước khi coi 1 thay đổi là hoàn chỉnh, tự rà lại các câu hỏi sau — đây là các điểm từng bị bỏ sót trong quá trình phát triển dự án này:

- [ ] Nếu vừa thêm/sửa logic dedup, đã xác nhận cả 2 trường hợp: (a) webhook/batch sync (race condition, atomic handle) và (b) CRUD manual (idempotency key) đều được bảo vệ chưa?
- [ ] Nếu vừa đổi concurrency/batch logic, đã cân nhắc ảnh hưởng ở cấp toàn hệ thống (nhiều customer cùng lúc), không chỉ cấp 1 job đơn lẻ?
- [ ] Test mới có che phủ đúng phần logic dễ sai nhất (dedup, product-filter, stats, batch-sync boundary, HMAC, CRUD idempotency, customer isolation) hay chỉ test phần dễ viết?
- [ ] Nếu vừa sửa/thêm hàng đợi (queue) hoặc cơ chế throttle, test có chứng minh vòng đời đầy đủ (dispatch → completion) hay chỉ chứng minh trạng thái ban đầu?

---

## 🔒 8. Independent Review — Bắt Buộc, Không Phải Tuỳ Chọn

Đây là bài học quan trọng nhất từ lần build trước: AI tự báo "test pass", "100% hoàn thành" **nhiều lần trong khi thực tế còn lỗi blocking nghiêm trọng** (auth sai, dedup lệch handle, rò rỉ dữ liệu chéo customer, app không build được). Test tự viết + tự chạy + tự báo cáo **không phải bằng chứng đáng tin**, vì mock có thể che giấu đúng những lỗi nghiêm trọng nhất, và assertion có thể bị viết lỏng để dễ pass.

**Quy định bắt buộc**:

1. Trước khi bất kỳ ai (kể cả AI) tuyên bố 1 module/feature là "hoàn thành" hoặc "production-ready", phải trải qua **review độc lập** — bởi 1 AI agent khác (không phải chính AI vừa code) hoặc 1 người khác — không tự AI code rồi tự AI đó xác nhận là xong.
2. Reviewer độc lập phải được yêu cầu chỉ ra **blocker cụ thể kèm vị trí file/dòng**, không chỉ nhận xét chung chung.
3. Sau khi AI code "sửa" các lỗi reviewer chỉ ra, **không tự tin là đã xong** — đưa lại cho reviewer độc lập lần 2 để đối chiếu danh sách lỗi cũ, xác nhận thực sự đã giảm, không chỉ đổi cách diễn đạt.
4. Chủ dự án (người, không phải AI) phải tự chạy tối thiểu 1 lần đủ 4 lệnh verify (mục 4) và tự đọc trực tiếp các file cốt lõi (auth, dedup, customer isolation) trước khi tin bất kỳ báo cáo "đã sửa" nào — không dựa hoàn toàn vào lời AI tường thuật lại.
5. Trước go-live, bắt buộc có **Phase Staging Verification**: chạy thử trên Shopify dev store thật (không phải mock) — đặc biệt cho: auth Admin GraphQL, GraphQL alias batching (kiểm tra có chạm giới hạn max complexity/aliases của Shopify không), customer data isolation (tạo tối thiểu 2 customer test, xác nhận không lẫn dữ liệu), webhook thật (không phải giả lập payload).
