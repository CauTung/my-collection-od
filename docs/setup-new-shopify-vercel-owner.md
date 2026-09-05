# Hướng dẫn setup source với Shopify app và Vercel project mới

> Phạm vi: triển khai source hiện tại sang một Shopify Dev/Partner organization mới và một Vercel project mới, sau đó xác minh App Proxy hoạt động.
>
> Tài liệu này không xác nhận source đã production-ready. Phần **Nợ kỹ thuật phải audit** ở cuối ghi rõ những điểm hiện chưa portable hoặc chưa an toàn để bàn giao production.

## 1. Các giá trị phải thay cho mỗi khách hàng

Tạo một bảng bàn giao nội bộ trước khi thao tác. Không ghi secret hoặc access token vào bảng này.

| Placeholder | Ví dụ định dạng | Lấy ở đâu |
|---|---|---|
| `<SHOPIFY_ORG>` | Tên organization | Shopify Dev Dashboard |
| `<SHOPIFY_APP_NAME>` | `Downies My Collection` | Tên app vừa tạo |
| `<SHOPIFY_CLIENT_ID>` | Chuỗi hexadecimal | App → Settings → Credentials |
| `<SHOPIFY_CLIENT_SECRET>` | Secret, không commit | App → Settings → Credentials |
| `<SHOP_DOMAIN>` | `customer-store.myshopify.com` | Shopify Admin/Dev Dashboard |
| `<VERCEL_PROJECT>` | `customer-my-collection` | Vercel project |
| `<PRODUCTION_DOMAIN>` | `customer-my-collection.vercel.app` | Vercel → Project → Settings → Domains |
| `<LEGACY_ADMIN_APP_NAME>` | `My Collection Admin API` | Tên Legacy custom app trong Shopify Admin |
| `<ADMIN_ACCESS_TOKEN>` | Token của Legacy custom app | Shopify Admin, theo mục 5 |
| `<SHOPIFY_CONFIG_NAME>` | `customer-production` | Tên config local do Shopify CLI tạo |

Quy tắc quan trọng:

- Không tái sử dụng `client_id`, app secret, Admin token, shop domain hoặc Vercel project ID của chủ source cũ.
- Không dùng URL deployment có chuỗi ngẫu nhiên, ví dụ `project-a1b2c3-owner.vercel.app`, trong Shopify.
- Chỉ dùng production domain cố định, ví dụ `project.vercel.app`, hoặc custom domain cố định.
- `SHOPIFY_CLIENT_SECRET` và `SHOPIFY_ADMIN_ACCESS_TOKEN` là hai credential khác nhau, thuộc hai app identity khác nhau trong setup hiện tại và không được dùng thay nhau.
- Không commit `.env`, `.env.local`, thư mục `.vercel`, token hoặc secret.

Vercel tạo URL riêng cho từng deployment nhưng tự cập nhật production domain để trỏ tới deployment mới. Vì vậy Shopify phải luôn trỏ tới production domain cố định, không trỏ tới URL vừa hiện sau chữ `Production` trong log deploy. Xem [Vercel CLI deployment workflow](https://vercel.com/docs/projects/deploy-from-cli) và [Vercel environments](https://vercel.com/docs/deployments/environments).

## 2. Yêu cầu máy local

- Git.
- Node.js phiên bản LTS tương thích với dependencies trong `app-shopify/package-lock.json`.
- npm.
- Tài khoản Vercel có quyền tạo/deploy project.
- Tài khoản Shopify có quyền tạo app và development store trong Dev Dashboard.
- Shopify CLI và Vercel CLI. Có thể gọi bằng `npx` để không phụ thuộc bản cài global.

Kiểm tra:

```powershell
node --version
npm --version
npx --yes vercel@latest --version
npx --yes @shopify/cli@latest version
```

Clone và cài dependencies:

```powershell
git clone <SOURCE_REPOSITORY_URL>
Set-Location <SOURCE_DIRECTORY>\app-shopify
npm ci
```

Không chạy `npm run build` ngay. Build hiện tại gọi `scripts/setup-metafields.ts` và sẽ ghi schema vào Shopify store được khai báo trong environment. Phải hoàn tất mục 3–6 trước.

## 3. Tạo Shopify app mới

Shopify hiện khuyến nghị tạo app trong Dev Dashboard cho integration riêng, hoặc dùng Shopify CLI nếu app sẽ được phân phối rộng. Xem [Create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard) và [Shopify app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration).

### 3.1 Tạo organization, store và app

1. Mở `https://dev.shopify.com/dashboard`.
2. Chọn đúng organization của khách hàng. Nếu chưa có, tạo organization mới.
3. Tạo development store trong chính organization này nếu đang setup môi trường dev/staging.
4. Vào **Apps** → **Create app**.
5. Đặt tên app theo khách hàng.
6. Mở **Settings** → **Credentials**.
7. Ghi lại Client ID và Client secret vào password manager/secrets manager.
8. Không dán secret vào `shopify.app.toml`; file TOML chỉ chứa Client ID công khai.

App và store phải thuộc cùng Dev Dashboard organization nếu muốn dùng client-credentials grant. Nếu store thuộc organization khác, grant này trả `shop_not_permitted`; khi đó cần custom distribution và OAuth/token exchange. Xem [Shopify client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant?lang=node).

### 3.2 Hiểu đúng hai app identity hiện tại

Source hiện tại không lấy Admin API token từ Partner app. Nó dùng:

| App identity | Credential dùng trong source | Trách nhiệm |
|---|---|---|
| Shopify Partner/Dev Dashboard app | `SHOPIFY_CLIENT_ID`, `SHOPIFY_APP_SECRET` | App Proxy config, App Proxy HMAC và các webhook được đăng ký bởi Partner app |
| Legacy custom app trong Shopify Admin | `SHOPIFY_ADMIN_ACCESS_TOKEN` | Mọi request GraphQL Admin API |

Vì vậy:

- `SHOPIFY_APP_SECRET` phải là **Client secret của Partner app** đang sở hữu App Proxy.
- `SHOPIFY_ADMIN_ACCESS_TOKEN` phải là **Admin API access token của Legacy custom app** trong đúng store.
- Không dùng API secret/client secret của Legacy custom app làm `SHOPIFY_APP_SECRET`.
- Không dùng Partner Client secret làm `SHOPIFY_ADMIN_ACCESS_TOKEN`.

Partner app hiện cần tối thiểu:

- `write_app_proxy`: cấu hình App Proxy.
- `read_orders`: bắt buộc cho các order/refund webhook đã khai báo trong TOML.

Legacy custom app cần các Admin API scopes ở mục 5.2. Các scope đó cấp cho token GraphQL, không phải tự động lấy từ `[access_scopes]` của Partner app.

Shopify quy định write scope bao gồm read access tương ứng. Quyền order mặc định chỉ đọc được 60 ngày; historical sync 10 năm không đúng chức năng nếu thiếu `read_all_orders`. Tham khảo [Shopify access scopes](https://shopify.dev/docs/api/usage/access-scopes) và [Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes).

Config Partner app tối thiểu để tái tạo App Proxy hiện tại:

```toml
[access_scopes]
scopes = "write_app_proxy,read_orders"
```

Partner app phải hoàn tất yêu cầu protected customer data liên quan trước khi production. Legacy custom app vẫn cần scope đọc order riêng cho Admin GraphQL và historical sync.

## 4. Tạo Vercel project mới

### 4.1 Convention bắt buộc cho repository này

Repository có app Node.js trong thư mục con `app-shopify`. Chỉ dùng một trong hai convention. Khuyến nghị convention A.

**Convention A — khuyến nghị:**

- Vercel project liên kết với repository root.
- Vercel **Root Directory** = `app-shopify`.
- Chạy `vercel` từ repository root.

**Convention B:**

- Vercel project liên kết trực tiếp với thư mục `app-shopify`.
- Vercel Root Directory để trống hoặc `.`.
- Chạy `vercel` từ `app-shopify`.

Không được trộn hai convention. Nếu Root Directory là `app-shopify` nhưng chạy Vercel CLI trong `app-shopify`, Vercel sẽ tìm `app-shopify/app-shopify` và báo:

```text
The specified Root Directory "app-shopify" does not exist.
```

### 4.2 Import qua Vercel Dashboard

1. Vào Vercel → **Add New Project**.
2. Import Git repository.
3. Đặt Project Name thành `<VERCEL_PROJECT>`.
4. Đặt Root Directory thành `app-shopify`.
5. Framework detection có thể để Vercel tự nhận; kiểm tra build log thực tế.
6. Build Command: `npm run build`.
7. Install Command: `npm install` hoặc `npm ci` nếu cấu hình hỗ trợ.
8. Chưa deploy cho tới khi thêm đủ environment variables ở mục 6.

### 4.3 Link bằng CLI

Chạy từ repository root, không phải từ `app-shopify`:

```powershell
npx --yes vercel@latest login
npx --yes vercel@latest link
```

Chọn đúng Vercel team và `<VERCEL_PROJECT>`. Lệnh tạo `.vercel/project.json`; file này phải nằm trong `.gitignore` và không được bàn giao như cấu hình dùng chung.

Vercel project settings được mô tả tại [Vercel project settings](https://vercel.com/docs/project-configuration/project-settings).

## 5. Tạo Admin API token

### 5.1 Phương án source đang dùng — Legacy custom app trong Shopify Admin

Nếu store vẫn cho phép tạo Legacy custom app:

1. Đăng nhập đúng `<SHOP_DOMAIN>` bằng tài khoản có quyền quản lý app.
2. Vào **Settings** → **Apps and sales channels**.
3. Mở **Develop apps** hoặc khu vực quản lý Legacy custom apps.
4. Nếu store yêu cầu, bật quyền cho phép custom app development.
5. Chọn **Create an app**.
6. Đặt tên `<LEGACY_ADMIN_APP_NAME>` và chọn app developer/owner phù hợp.
7. Mở **Configuration** → **Admin API integration**.
8. Chọn scopes theo mục 5.2.
9. Save rồi chọn **Install app**.
10. Reveal/copy Admin API access token ngay khi Shopify hiển thị. Token có thể chỉ được hiển thị một lần.
11. Lưu token vào password manager/secrets manager.
12. Gán token này vào `SHOPIFY_ADMIN_ACCESS_TOKEN` ở local và Vercel.

Không copy API key/API secret của Legacy custom app vào `SHOPIFY_APP_SECRET`. App Proxy được Shopify ký bằng Client secret của Partner app, không phải credential của Legacy custom app.

### 5.2 Admin API scopes của Legacy custom app

Token hiện cần các nhóm quyền sau:

- `read_orders`: đọc orders cho batch sync.
- `read_all_orders`: cần cho lookback 10 năm; đây là quyền hạn chế và có thể cần Shopify phê duyệt.
- `write_customers`: đọc customer và ghi cached stats/sync metafields.
- `write_products`: đọc Product metafields và tạo Product metafield definitions trong setup script.
- `write_metaobjects`: CRUD collection items và dedup locks.
- `write_metaobject_definitions`: tạo/đọc metaobject definitions trong setup script.

Shopify quy định write scope bao gồm read access tương ứng. Quyền order mặc định chỉ đọc được 60 ngày; historical sync 10 năm không đúng chức năng nếu thiếu `read_all_orders`. Tham khảo [Shopify access scopes](https://shopify.dev/docs/api/usage/access-scopes) và [Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes).

Sau khi đổi scope của Legacy custom app, phải save/reinstall hoặc cập nhật app theo UI Shopify yêu cầu, rồi xác nhận token thực tế có quyền bằng một GraphQL query. Không chỉ nhìn checkbox trong Admin.

### 5.3 Nếu store mới không cho tạo Legacy custom app

Shopify hiện đã chuyển app creation sang Dev Dashboard và tài liệu chính thức nói admin-created custom apps mới không còn được tạo đại trà. Vì vậy quy trình Legacy custom app chỉ áp dụng cho store/account vẫn có khả năng này hoặc app legacy đã tồn tại.

Các hướng thay thế:

1. Nếu app và store cùng Shopify organization, dùng client-credentials grant. Token chỉ sống khoảng 24 giờ nên source phải tự lấy/gia hạn, không thể paste một lần vào Vercel rồi để chạy lâu dài.
2. Nếu store khách hàng thuộc organization khác, dùng custom distribution và authorization-code grant/token exchange phù hợp.

Source hiện chưa implement cả hai token lifecycle trên. Đây là blocker cần xử lý trong audit, không được giải quyết bằng cách copy token từ store/app cũ.

Ví dụ request client-credentials cho môi trường dev cùng organization:

```text
POST https://<SHOP_DOMAIN>/admin/oauth/access_token
Content-Type: application/x-www-form-urlencoded

client_id=<SHOPIFY_CLIENT_ID>
client_secret=<SHOPIFY_CLIENT_SECRET>
grant_type=client_credentials
```

**Cảnh báo:** token này hết hạn sau khoảng 24 giờ. Source hiện chỉ đọc token tĩnh từ environment và chưa tự refresh. Vì vậy phương án này chỉ đủ để setup/dev, chưa đủ cho production vận hành liên tục. Xem [Shopify access-token lifetimes](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

Source hiện không có implementation hoàn chỉnh cho:

- install/auth entry route;
- OAuth callback thực tế;
- token exchange;
- lưu token theo shop;
- refresh/rotation/revocation.

`/api/auth/callback` đang xuất hiện trong config nhưng không có route tương ứng trong source. Không được coi redirect URL đó là bằng chứng OAuth đã hoạt động.

Kết luận: Legacy custom app là phương án đang chạy ở project hiện tại. Trước khi bàn giao cho store không hỗ trợ cách này, audit phải thiết kế và implement auth/token lifecycle. Xem [Shopify access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

## 6. Cấu hình environment variables

### 6.1 Local

Trong `app-shopify`:

```powershell
Copy-Item .env.example .env
```

Điền:

```dotenv
SHOPIFY_APP_SECRET=<SHOPIFY_CLIENT_SECRET>
SHOPIFY_CLIENT_ID=<SHOPIFY_CLIENT_ID>
SHOPIFY_ADMIN_ACCESS_TOKEN=<ADMIN_ACCESS_TOKEN>
SHOPIFY_SHOP_DOMAIN=<SHOP_DOMAIN>
APP_HOST=https://<PRODUCTION_DOMAIN>
NODE_ENV=development
```

Các biến tùy chọn:

```dotenv
YOTPO_APP_KEY=
YOTPO_SECRET=
KLAVIYO_API_KEY=
```

Không thêm dấu nháy thừa, khoảng trắng cuối dòng hoặc prefix `https://` vào `SHOPIFY_SHOP_DOMAIN`.

### 6.2 Vercel

Vào Vercel → Project → Settings → Environment Variables và thêm tối thiểu:

| Name | Environment | Giá trị |
|---|---|---|
| `SHOPIFY_APP_SECRET` | Production | `<SHOPIFY_CLIENT_SECRET>` |
| `SHOPIFY_CLIENT_ID` | Production | `<SHOPIFY_CLIENT_ID>` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Production | `<ADMIN_ACCESS_TOKEN>` |
| `SHOPIFY_SHOP_DOMAIN` | Production | `<SHOP_DOMAIN>` |
| `APP_HOST` | Production | `https://<PRODUCTION_DOMAIN>` |
| `NODE_ENV` | Production | `production` |

Nếu deploy Preview để test, phải thêm bộ biến riêng cho Preview. Không để Preview vô tình gọi production store nếu chưa chủ động chấp nhận rủi ro đó.

Sau khi thêm hoặc đổi biến, bắt buộc redeploy. Vercel chỉ áp environment variable mới cho deployment kế tiếp. Xem [Vercel environment variables](https://vercel.com/docs/environment-variables).

Kiểm tra tên biến, không in giá trị:

```powershell
npx --yes vercel@latest env ls production
```

## 7. Deploy Vercel lần đầu và lấy production domain cố định

Chạy từ repository root theo convention A:

```powershell
npx --yes vercel@latest --prod --yes
```

Một deploy thành công thường in hai URL:

```text
Production  https://project-random-owner.vercel.app
Aliased     https://project.vercel.app
```

Giá trị cần điền vào Shopify là URL sau `Aliased`, không phải URL sau `Production`.

Xác minh:

```powershell
curl.exe -I https://<PRODUCTION_DOMAIN>/
```

Kỳ vọng HTTP 200. Khi mở backend root trực tiếp, trang có thể chỉ nói app phải được truy cập qua Shopify storefront; đây là bình thường vì request trực tiếp không có App Proxy signature.

## 8. Link source với Shopify app mới

Không deploy bằng Client ID đang có sẵn trong source.

Từ `app-shopify`:

```powershell
npx --yes @shopify/cli@latest auth login
npx --yes @shopify/cli@latest app config link
```

1. Chọn đúng Shopify organization.
2. Chọn đúng app mới.
3. Nếu CLI phát hiện `shopify.app.toml` hiện có, đặt config mới là `<SHOPIFY_CONFIG_NAME>`.
4. Kiểm tra file được tạo, thường là `shopify.app.<SHOPIFY_CONFIG_NAME>.toml`.
5. Dùng config có tên để tránh ghi nhầm vào app cũ. Shopify hỗ trợ nhiều config cho development/staging/production; xem [Manage Shopify app config files](https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files).

## 9. Cập nhật Shopify config

Trong config dành cho khách hàng, thay toàn bộ placeholder:

```toml
client_id = "<SHOPIFY_CLIENT_ID>"
name = "<SHOPIFY_APP_NAME>"
application_url = "https://<PRODUCTION_DOMAIN>"
embedded = true

[access_scopes]
scopes = "write_app_proxy,read_orders"

[auth]
redirect_urls = [
  "https://<PRODUCTION_DOMAIN>/api/auth/callback"
]

[webhooks]
api_version = "2026-07"

[[webhooks.subscriptions]]
topics = ["orders/paid"]
uri = "/api/webhooks/orders-paid"

[[webhooks.subscriptions]]
topics = ["orders/cancelled"]
uri = "/api/webhooks/orders-cancelled"

[[webhooks.subscriptions]]
topics = ["refunds/create"]
uri = "/api/webhooks/refunds-create"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request"]
uri = "/api/webhooks/customers-data-request"

[[webhooks.subscriptions]]
compliance_topics = ["customers/redact"]
uri = "/api/webhooks/customers-redact"

[[webhooks.subscriptions]]
compliance_topics = ["shop/redact"]
uri = "/api/webhooks/shop-redact"

[app_proxy]
url = "https://<PRODUCTION_DOMAIN>"
subpath = "my-collection"
prefix = "apps"
```

Lưu ý:

- `url` của App Proxy trỏ tới root vì handler thực tế là index route `app/routes/home.tsx`.
- `[access_scopes]` ở đây thuộc Partner app. Admin GraphQL scopes của Legacy custom app được cấu hình riêng trong Shopify Admin.
- Storefront URL sẽ là `https://<SHOP_DOMAIN>/apps/my-collection`.
- App Proxy chỉ có một root route trên mỗi app.
- Prefix/subpath có thể đã bị merchant tùy chỉnh và không tự đổi cho installation cũ. Có thể cần chỉnh trong Shopify Admin hoặc uninstall/reinstall app. Xem [Shopify App Proxy behavior](https://shopify.dev/docs/apps/build/online-store/app-proxies/index).
- `<AUDITED_SUPPORTED_API_VERSION>` phải được chốt trong audit. Source hiện đang pin nhiều API version cũ và không đồng nhất.

Release config:

```powershell
npx --yes @shopify/cli@latest app deploy --config <SHOPIFY_CONFIG_NAME> --allow-updates
```

Sau khi release, mở Dev Dashboard → App → Versions và xác nhận version mới chứa đúng:

- Client ID/app;
- application URL;
- App Proxy destination;
- scopes;
- webhook API version.

Shopify chỉ áp thay đổi TOML lên production sau khi `shopify app deploy` release version mới.

## 10. Cài app vào store

1. Mở Shopify Dev Dashboard → app mới → Home.
2. Chọn **Install app**.
3. Chọn đúng `<SHOP_DOMAIN>`.
4. Duyệt các scopes.
5. Nếu app đã cài trước khi đổi scope, merchant phải approve scope mới.
6. Nếu đổi App Proxy prefix/subpath sau khi cài, kiểm tra Shopify Admin → Settings → Apps and sales channels → app → App proxy; có thể phải uninstall/reinstall.

## 11. Tạo Shopify native schema

Script `scripts/setup-metafields.ts` tạo:

- `collection_item` metaobject definition;
- `collection_dedup_lock` metaobject definition;
- `my_collection.*` Customer metafield definitions;
- `collectible_data.*` Product metafield definitions.

Chạy một lần có giám sát từ `app-shopify`:

```powershell
npx tsx scripts/setup-metafields.ts
```

Không chỉ tin dòng `Setup complete`. Kiểm tra trực tiếp trong Shopify Admin:

- Content → Metaobjects;
- Settings → Custom data → Customers;
- Settings → Custom data → Products.

Nếu script báo namespace/type đã tồn tại, dừng và kiểm tra schema/ownership trước khi chạy tiếp. Không tự đổi namespace ở một file duy nhất vì runtime hiện còn hardcode cùng namespace/type ở nhiều module.

## 12. Chạy kiểm tra local bắt buộc

Từ `app-shopify`, chạy riêng từng lệnh và lưu nguyên output:

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

`npm run build` hiện gọi setup script trước khi build, vì vậy nó cần token thật và có thể ghi vào Shopify store. Đây là nợ kỹ thuật cần tách trong audit.

## 13. Deploy production chính thức

Sau khi bốn bước local pass:

```powershell
Set-Location <SOURCE_DIRECTORY>
npx --yes vercel@latest --prod --yes
```

Xác nhận log có:

```text
readyState: READY
Aliased: https://<PRODUCTION_DOMAIN>
```

Không sửa Shopify config sang URL deployment mới. Alias cố định tự trỏ tới deployment mới.

## 14. Verify App Proxy end-to-end

### 14.1 Backend direct

```powershell
curl.exe -I https://<PRODUCTION_DOMAIN>/
```

Kỳ vọng HTTP 200.

### 14.2 Storefront thật

Đăng nhập customer trên storefront rồi mở:

```text
https://<SHOP_DOMAIN>/apps/my-collection
```

Kỳ vọng:

- không có `App Proxy HMAC verification failed`;
- response được render trong Shopify theme;
- dashboard xuất hiện;
- request API con dùng `/apps/my-collection/api/...`;
- customer A không đọc được item của customer B.

Store password-protected sẽ redirect request không có browser session tới `/password`. Hãy test bằng browser session đã mở khóa store.

### 14.3 Production HMAC expectations

- Request App Proxy thật có `signature`, `shop`, `timestamp`, `path_prefix` và có thể có `logged_in_customer_id`.
- Signature hợp lệ phải trả HTTP 200 và dashboard.
- Signature sai phải trả HTTP 401.
- Vercel `SHOPIFY_APP_SECRET` phải đúng Client secret của chính app đang cấu hình App Proxy.

Shopify ký App Proxy bằng cách nhóm duplicate query keys, nối duplicate values bằng dấu phẩy, sort các entry `key=value`, rồi nối các entry không có dấu `&`. Xem [Authenticate app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies).

## 15. Webhooks

Source có handler cho:

- `orders/paid` → `/api/webhooks/orders-paid`;
- `orders/cancelled` → `/api/webhooks/orders-cancelled`;
- `refunds/create` → `/api/webhooks/refunds-create`;
- `customers/data_request` → `/api/webhooks/customers-data-request`;
- `customers/redact` → `/api/webhooks/customers-redact`;
- `shop/redact` → `/api/webhooks/shop-redact`.

`shopify.app.toml` đã khai báo app-specific subscriptions bằng relative URI. Mỗi delivery được verify raw-body HMAC, signed shop và topic trước khi parse JSON.

Sau khi đổi config, phải chạy `shopify app deploy` và release version mới thì subscription production mới có hiệu lực. Trước đó kiểm tra và xóa shop-specific subscription trùng nếu có. Sau deploy, test delivery thật bằng Shopify CLI/Dev Dashboard; compliance webhooks là bắt buộc với app phân phối qua App Store. Xem [Manage webhook subscriptions](https://shopify.dev/docs/apps/build/webhooks/subscribe) và [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

## 16. Troubleshooting nhanh

### `App Proxy HMAC verification failed`

Kiểm tra theo thứ tự:

1. Shopify App Proxy đang thuộc đúng app/Client ID chưa?
2. Vercel `SHOPIFY_APP_SECRET` có đúng Client secret của app đó không?
3. Secret vừa đổi đã redeploy Vercel chưa?
4. Shopify TOML vừa đổi đã `shopify app deploy` và release version chưa?
5. App Proxy destination có dùng production alias cố định không?
6. Store installation có giữ prefix/subpath tùy chỉnh cũ không?
7. Request có đi qua storefront `/apps/my-collection`, hay đang gọi backend trực tiếp?
8. Vercel logs có request vào đúng production project không?

Không log raw secret hoặc full signed URL ở production.

### `The specified Root Directory "app-shopify" does not exist`

Đang trộn hai Vercel conventions. Nếu Vercel Root Directory là `app-shopify`, chạy CLI từ repository root.

### `shop_not_permitted`

App và store không cùng Dev Dashboard organization. Không thể dùng client-credentials grant; cần custom distribution + OAuth/token exchange.

### GraphQL trả `ACCESS_DENIED`

- Token chưa có scope cần thiết.
- Scope đã đổi trong TOML nhưng app version chưa release.
- Merchant chưa approve scope mới.
- `read_all_orders` chưa được Shopify phê duyệt.
- Token thuộc app/store khác.

### Build pass nhưng runtime GraphQL fail sau một ngày

Đang dùng client-credentials token 24 giờ nhưng source không refresh token. Đây là blocker kiến trúc, không phải lỗi Vercel cache.

## 17. Checklist bàn giao

- [ ] Shopify app mới thuộc đúng organization.
- [ ] Store đúng organization hoặc đã chọn đúng distribution/auth flow.
- [ ] Client ID trong config là của app mới.
- [ ] Client secret chỉ nằm trong local/Vercel secrets.
- [ ] Vercel Root Directory và vị trí chạy CLI theo cùng một convention.
- [ ] Production domain cố định được dùng ở mọi Shopify URL.
- [ ] Không còn deployment URL ngẫu nhiên trong tracked files.
- [ ] Vercel Production có đủ environment variables.
- [ ] Shopify app version mới đã release.
- [ ] App đã cài và scopes đã approve.
- [ ] Native schema đã được kiểm tra trực tiếp trong Shopify Admin.
- [ ] Đủ bốn lệnh verification pass.
- [ ] App Proxy thật trả dashboard.
- [ ] Invalid HMAC trả 401.
- [ ] Customer isolation được test bằng hai customer thật.
- [ ] Webhook subscriptions và deliveries đã được kiểm tra thật.
- [ ] Không có secret/token trong Git history, logs hoặc tài liệu bàn giao.

## 18. Nợ kỹ thuật phải audit trước khi bàn giao production

Các mục dưới đây được ghi nhận từ trạng thái source hiện tại, không phải giả định:

1. `shopify.app.toml` đang chứa Client ID và domain của deployment hiện tại; cần chiến lược config template + named environment configs.
2. Runtime phụ thuộc token tĩnh của một Legacy custom app riêng; chưa có token lifecycle cho Partner/custom-distribution app mới.
3. `/api/auth/callback` được cấu hình nhưng route không tồn tại.
4. GraphQL Admin API runtime/setup version vẫn hardcode và chưa đồng nhất với webhook API version.
5. `scripts/setup-metafields.ts` gọi `fetch()` trực tiếp thay vì `shopifyGraphQL()` và hardcode API version/namespaces/types.
6. `npm run build` luôn chạy script tạo schema có side effect lên Shopify store.
7. Quyền vẫn bị chia giữa Partner app và Legacy custom app; cần machine-readable environment/scope validation.
8. App-specific webhook subscriptions đã có trong TOML nhưng chưa deploy/release và chưa verify delivery thật.
9. `APP_HOST` có trong env contract nhưng chưa thấy được runtime sử dụng nhất quán.
10. Dashboard Liquid/HTML/JavaScript đang bị duplicate giữa `home.tsx` và `app.my-collection.tsx`.
11. Vercel build cảnh báo chưa phát hiện `vercelPreset()` cho React Router; cần audit deployment adapter/output chính thức.
12. Namespace/type/config constants vẫn rải rác ngoài `app/config/constants.ts`.
13. Webhook routes đã dùng shared authentication/parser và `withErrorHandler()`; partial item failure/dedup retry vẫn là residual risk cần quyết định.
14. Cần rà lại toàn bộ hardcode numeric/string, GraphQL API versions, route paths và external URLs.

Đây là danh sách đầu vào cho phiên audit kế tiếp. Không sửa rời rạc từng mục trước khi lập dependency map và test baseline, vì auth, scopes, token storage, webhook subscriptions và deployment config ảnh hưởng lẫn nhau.

Kế hoạch audit chi tiết và thứ tự remediation được định nghĩa tại `docs/code-audit-plan.md`.
