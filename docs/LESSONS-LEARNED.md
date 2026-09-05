# Lessons Learned — Shopify App Proxy "My Collection"

> **Mục đích**: Ghi lại TẤT CẢ các lỗi, bẫy, và cách khắc phục đã gặp khi build app này.
> Đọc file này TRƯỚC KHI sửa hoặc rebuild bất kỳ phần nào.
>
> **Cập nhật lần cuối**: 2026-09-05

---

## 🔴 16. Shopify OAuth Redirect URL bắt buộc HTTPS (Lỗi HTTP 400 Bad Request)

### Triệu chứng
Khi chạy script `scripts/get-token.ts` với `redirect_uri=http://localhost:3334/callback` để lấy token, Shopify trả về màn hình lỗi **HTTP 400 Bad Request / Invalid Redirect URI**.

### Nguyên nhân gốc
Shopify Partner API từ năm 2024 quy định ngặt nghèo: Tất cả `redirect_urls` phục vụ luồng cấp quyền OAuth bắt buộc phải sử dụng giao thức bảo mật `HTTPS`. Các đường dẫn `http://localhost:...` không được chấp nhận qua tham số callback trực tiếp trừ khi đi qua Shopify CLI session.

### Cách khắc phục chuẩn xác
1. **Dùng Custom App Access Token (Khuyên dùng 100%)**:
   - Truy cập **Shopify Admin** > **Settings** > **Apps and sales channels** > **Develop apps**.
   - Tạo custom app (vd: `Admin API Token`), cấp đủ Admin API Scopes (`orders`, `products`, `customers`, `metaobjects`).
   - Copy token `shpat_...` dán vào `SHOPIFY_ADMIN_ACCESS_TOKEN` trong file `.env`. Token này tồn tại vĩnh viễn không bị hết hạn hoặc lỗi redirect URL.
2. **Tránh tự viết script OAuth callback HTTP đơn lẻ** cho dev store vì phụ thuộc vào redirect domain HTTPS.
---

## 🔴 17. Đổi URL Tunnel Liên Tục Làm Chết App Proxy & Lỗi ".env"

### Triệu chứng
Mỗi lần khởi động lại server hoặc thay đổi `application_url` trong `shopify.app.toml`, App Proxy trên Storefront bắn lỗi "There was an error in the third-party application." 
Đồng thời, URL OAuth callback cũng hỏng liên tục khiến developer phải cấp lại quyền và lấy lại file `.env` liên miên.

### Nguyên nhân gốc
- Shopify CLI kết hợp với các free tunnel (như Cloudflare trycloudflare, ngrok free) sinh ra một tên miền ngẫu nhiên mới mỗi lần sập.
- Nếu bạn "hardcode" tên miền này vào `shopify.app.toml`, một khi tunnel cũ sập, Shopify vẫn trỏ vào tên miền cũ đã chết → HTTP 502/404 → App Proxy báo lỗi "Third-party application error".
- Token OAuth cấp cho domain/app cũ sẽ mất kết nối hoặc phải sinh lại từ đầu.

### Cách khắc phục chuẩn xác (Bài học xương máu)
1. **Dùng Custom App Access Token (`shpat_...`)**: Tuyệt đối không dùng OAuth token động (`shpua_...`) bằng các script tự chế trên dev store. Hãy sinh Token 1 lần vĩnh viễn ở trang Custom App của Admin Shopify và gán vào `.env`. Nó sẽ sống vĩnh viễn mặc kệ Tunnel có đổi URL hàng trăm lần.
2. **Quản lý Tunnel độc lập**: Đừng gán cờ `--tunnel-url` cứng vào CLI nếu bạn dùng free tunnel. Hãy dùng 1 dịch vụ Tunnel cố định (như Pinggy hoặc Cloudflared giữ nguyên file config), lấy 1 URL chạy nền, sau đó mới cho CLI khởi động theo URL đó.

---

## 🔴 1. Shopify App Proxy KHÔNG chấp nhận full HTML document

### Triệu chứng
Shopify storefront hiện: **"There was an error in the third-party application."**

### Nguyên nhân gốc
React Router v8 SSR render ra full HTML document (`<html><head><body>...</body></html>`).
Shopify App Proxy **chỉ chấp nhận**:
- `Content-Type: application/liquid` → HTML fragment (Shopify inject vào theme layout)
- `Content-Type: application/json` → JSON data

Khi nhận full HTML document, App Proxy không biết xử lý → hiện lỗi.

### Cách sửa
- Route cho App Proxy **KHÔNG được có `default export` React component** (vì React Router sẽ SSR render nó).
- Route chỉ có `loader` function, trả `new Response(htmlFragment, { headers: { "Content-Type": "application/liquid" } })`.
- UI render bằng inline HTML/CSS/JS trong Liquid fragment, fetch data qua API routes.

### File liên quan
- `app/routes/home.tsx` — App Proxy entry point

---

## 🔴 2. App Proxy forward request tới ROOT path `/`, KHÔNG phải `/app/my-collection`

### Triệu chứng
Route `/app/my-collection` không bao giờ nhận được request từ App Proxy.

### Nguyên nhân gốc
Cấu hình App Proxy trong `shopify.app.toml`:
```toml
[app_proxy]
url = "https://backend.com"
subpath = "my-collection"
prefix = "apps"
```
Khi user truy cập `https://shop.myshopify.com/apps/my-collection`:
- Shopify forward tới `https://backend.com/` ← **ROOT**, không phải `/app/my-collection`
- Path sau subpath mới được append: `/apps/my-collection/foo/bar` → `https://backend.com/foo/bar`

### Cách sửa
- Đặt App Proxy handler ở **index route** (`home.tsx`, path `/`).
- Detect App Proxy request bằng cách check `signature` query param.
- Nếu có `signature` → verify HMAC → trả Liquid response.
- Nếu không có `signature` → trả page thường (direct access).

---

## 🔴 3. React Router v8 `flatRoutes()` không hoạt động ở runtime

### Triệu chứng
`npx react-router routes` hiện đúng route tree, nhưng runtime báo:
```
Error: No route matches URL "/app/my-collection"
```

### Nguyên nhân gốc
Package `@react-router/fs-routes` resolve routes đúng ở CLI (build time) nhưng không resolve ở runtime (dev server). Có thể do version mismatch hoặc Vite plugin conflict.

### Cách sửa
Khai báo route **tường minh** trong `app/routes.ts`:
```typescript
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/collection", "routes/api.collection.ts"),
  // ... tất cả routes khác
] satisfies RouteConfig;
```
**Không dùng `flatRoutes()`** — khai báo thủ công an toàn hơn.

### File liên quan
- `app/routes.ts`

---

## 🔴 4. Pinggy tunnel hiện màn hình "Caution" chặn App Proxy

### Triệu chứng
Truy cập App Proxy URL → thấy HTML page "Caution - you are about to visit a website that is served for free through pinggy.io" thay vì nội dung app.

### Nguyên nhân gốc
Pinggy free tier inject một trang HTML cảnh báo anti-phishing trước khi cho phép truy cập thật.
Trang này cần user bấm nút "Enter site" bằng browser.
Shopify App Proxy gọi server-to-server (không có browser) → mắc kẹt ở trang cảnh báo mãi.

### Cách sửa
- **Không dùng Pinggy** cho App Proxy.
- Dùng **Cloudflare Tunnel** (`cloudflared`): miễn phí, không có interstitial page, nhanh.
```bash
# Download cloudflared
Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile cloudflared.exe

# Chạy tunnel
.\cloudflared.exe tunnel --url http://localhost:5173
```
- URL tunnel dạng: `https://random-words.trycloudflare.com`
- Cập nhật URL vào `shopify.app.toml` rồi `npx @shopify/cli@latest app deploy --allow-updates`

### Lưu ý
- Cloudflare tunnel URL **thay đổi mỗi lần chạy** (free tier). Phải deploy lại config sau mỗi lần restart.
- Ngrok cũng hoạt động nhưng cần account + authtoken.

---

## 🟡 5. `shopify app dev` luôn dùng Pinggy dù đã xóa URL trong TOML

### Triệu chứng
Chạy `shopify app dev` → nó tự sinh Pinggy tunnel URL, bỏ qua Cloudflare tunnel đang chạy.

### Nguyên nhân gốc
Shopify CLI (`@shopify/cli`) có built-in tunnel provider (Pinggy). Khi `application_url` không được set trong TOML, CLI tự động tạo tunnel qua Pinggy.

### Cách sửa
- Không dùng `shopify app dev` cho App Proxy testing.
- Chạy `npm run dev` (Vite dev server) + Cloudflare tunnel riêng.
- Set `application_url` trong TOML thành Cloudflare tunnel URL.
- Hoặc dùng `shopify app dev --tunnel-url=https://your-cloudflare.trycloudflare.com:443` (nếu CLI hỗ trợ).

---

## 🟡 6. `withErrorHandler` dùng sai cách (HOF pattern)

### Triệu chứng
Loader trả response không đúng hoặc throw error.

### Nguyên nhân gốc
`withErrorHandler` là Higher-Order Function — nhận handler, trả về function mới:
```typescript
// ❌ SAI — trả về function, không gọi nó
export const loader = async ({ request }) => {
  return withErrorHandler(async () => { ... });
};

// ✅ ĐÚNG — withErrorHandler bọc handler
export const loader = withErrorHandler(async ({ request }) => { ... });
```

### File liên quan
- `app/lib/error-handler.server.ts` — định nghĩa withErrorHandler
- Tất cả route files dùng withErrorHandler

---

## 🟡 7. OAuth Token phải lấy thủ công (không tự động)

### Triệu chứng
Cài app xong nhưng không có `SHOPIFY_ADMIN_ACCESS_TOKEN`.

### Nguyên nhân gốc
App architecture "0-Database" không dùng Shopify's managed auth flow.
Token phải lấy qua OAuth flow thủ công.

### Cách sửa
1. Chạy: `npx tsx scripts/get-token.ts`
2. Mở URL nó in ra trong browser → cấp quyền
3. Script capture token → copy vào `.env`

### Lưu ý quan trọng
- `SHOPIFY_APP_SECRET` ≠ `SHOPIFY_ADMIN_ACCESS_TOKEN` → **HAI SECRET KHÁC NHAU**
- `SHOPIFY_APP_SECRET`: verify HMAC (App Proxy + Webhook)
- `SHOPIFY_ADMIN_ACCESS_TOKEN`: gọi Admin GraphQL API
- **Lẫn 2 cái này là lỗi chết người** (đã xảy ra ở lần build trước)

---

## 🟡 8. Setup Metafields script phải chạy trước build

### Triệu chứng
App chạy nhưng GraphQL queries fail vì thiếu Metaobject definitions.

### Nguyên nhân gốc
Shopify Metaobject definitions (schema cho "0-Database") phải được tạo trước khi app sử dụng.

### Cách sửa
Script `scripts/setup-metafields.ts` đã được tích hợp vào `build` script:
```json
"build": "tsx scripts/setup-metafields.ts && react-router build"
```
Script kiểm tra namespace collision và skip nếu đã tồn tại.

### Lưu ý
- Cần `SHOPIFY_ADMIN_ACCESS_TOKEN` và `SHOPIFY_SHOP_DOMAIN` trong env
- Cần scope `read_metaobject_definitions` + `write_metaobject_definitions`

---

## 🟡 9. Port conflict khi chạy OAuth script

### Triệu chứng
```
Error: listen EADDRINUSE: address already in use :::3333
```

### Cách sửa
Kill process đang chiếm port:
```powershell
# Tìm process
netstat -ano | findstr :3333
# Kill nó
taskkill /PID <pid> /F
```
Hoặc đổi port trong `scripts/get-token.ts`.

---

## 🟡 10. `extractAppProxySession` KHÔNG verify HMAC

### Triệu chứng
API routes gọi `extractAppProxySession()` nhưng không verify HMAC trước → request giả mạo có thể qua.

### Nguyên nhân gốc
`session.server.ts` chỉ extract params, không verify signature.
Comment trong code nói "This module does NOT verify HMAC — that must be done first in the route handler."

### Cách sửa
Mỗi route handler phải tự gọi `verifyAppProxyHmac()` TRƯỚC `extractAppProxySession()`:
```typescript
const params = getQueryParams(request);
verifyAppProxyHmac(params); // Verify FIRST
const session = extractAppProxySession(request); // Then extract
```

### File liên quan
- `app/lib/hmac.server.ts` — HMAC verification
- `app/lib/session.server.ts` — Session extraction
- Tất cả API route files

---

## 🟡 11. API routes qua App Proxy — request params tự động thêm bởi Shopify

### Cách hoạt động
Khi client JS trong storefront fetch `/apps/my-collection/api/collection`:
1. Request đi tới Shopify App Proxy
2. Shopify thêm query params: `signature`, `shop`, `logged_in_customer_id`, `timestamp`, `path_prefix`
3. Shopify forward tới `https://backend.com/api/collection?signature=...&shop=...&...`
4. Backend verify HMAC → extract customer → xử lý

### Lưu ý
- Client JS **KHÔNG cần** tự thêm authentication headers
- Shopify tự xử lý auth và forward params
- `credentials: "same-origin"` trong fetch để gửi cookies nếu cần

---

## 🔵 12. Deploy config — Lệnh chuẩn

```bash
# Deploy config changes (non-interactive)
npx @shopify/cli@latest app deploy --allow-updates

# Dev server (local)
npm run dev

# Cloudflare tunnel (separate terminal)
.\cloudflared.exe tunnel --url http://localhost:5173

# Build + verify
npm run typecheck
npm test
npm run lint
npm run build
```

---

## 🔵 13. Checklist trước khi test App Proxy

- [ ] `.env` có đủ: `SHOPIFY_APP_SECRET`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_SHOP_DOMAIN`
- [ ] Cloudflare tunnel đang chạy và URL khớp với `shopify.app.toml`
- [ ] Đã chạy `npx @shopify/cli@latest app deploy --allow-updates` sau khi đổi URL
- [ ] `npm run dev` đang chạy (port 5173)
- [ ] Route `/` (home) trả 200 khi truy cập trực tiếp
- [ ] Route `/` trả 401 khi có `signature=fake` (HMAC reject đúng)
- [ ] Vào storefront: `https://my-collection-od.myshopify.com/apps/my-collection`

---

## 🔵 14. Kiến trúc App Proxy — Flow diagram

```
User Browser
    │
    ▼
Shopify Storefront (https://shop.myshopify.com/apps/my-collection)
    │
    │  Shopify adds: signature, shop, logged_in_customer_id, timestamp, path_prefix
    ▼
Cloudflare Tunnel (https://random.trycloudflare.com/)
    │
    ▼
Vite Dev Server (http://localhost:5173/)
    │
    ├─ GET / (with signature) → home.tsx loader → verify HMAC → return Liquid HTML fragment
    │                                                              Content-Type: application/liquid
    │
    ├─ GET /api/collection → api.collection.ts loader → verify HMAC → return JSON
    │
    ├─ POST /api/collection → api.collection.ts action → verify HMAC → create item → return JSON
    │
    └─ POST /api/collection/sync → api.collection.sync.ts → trigger batch sync
```

---

## 🔵 15. Các lệnh hay dùng

```bash
# Xem route tree (check route matching)
npx react-router routes

# Test route locally
curl.exe -s -w "\nHTTP: %{http_code} | TYPE: %{content_type}" "http://localhost:5173/"

# Test qua tunnel
curl.exe -s -w "\nHTTP: %{http_code}" "https://your-tunnel.trycloudflare.com/"

# Lấy OAuth token
npx tsx scripts/get-token.ts

# Setup Metafields (DB schema)
npx tsx scripts/setup-metafields.ts
```
