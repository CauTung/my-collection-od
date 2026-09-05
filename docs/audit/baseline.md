# Audit Baseline

## Snapshot

- Date: 2026-09-05
- Branch: `main`
- Base commit: `54e59a9910e9f76ffff9263a4e7ff001ddab8789`
- Application directory: `app-shopify/`
- Runtime: React Router v7 on Vercel
- Data layer: Shopify metaobjects and metafields; no external database

The working tree already contained owner setup, deployment configuration, App Proxy HMAC, route, and architecture changes before Batch A. No existing change was discarded or reverted.

## Verification Baseline After Batch A

| Command | Result | Exact result |
| --- | --- | --- |
| `npm run typecheck` | Pass | Type generation and `tsc` exited with code 0 |
| `npm test` | Pass | 11 files passed; 66 tests passed |
| `npm run lint` | Pass | ESLint exited with code 0 |
| `npm run build` | Pass | Shopify schema setup reported existing definitions, then client and SSR builds completed |
| `npm test -- --coverage` | Pass | `hmac.server.ts` omitted from the uncovered-file table because statements, branches, functions, and lines reached 100% |

Important baseline side effect: `npm run build` executes `scripts/setup-metafields.ts` against the configured Shopify store before compiling. The 2026-09-05 run found every definition already present. This remains an open P2 audit item.

## Customer Route Authentication Matrix

| Route | Methods | Identity source | Authentication entry point | Unsigned behavior |
| --- | --- | --- | --- | --- |
| `/` when reached through App Proxy | GET | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | Direct root access shows a public informational page and exposes no customer data |
| `/app/my-collection` | GET | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |
| `/apps/my-collection` and splat | GET | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |
| `/api/collection` | GET, POST | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |
| `/api/collection/:item_id` | PUT, DELETE | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |
| `/api/collection/:item_id/wishlist` | POST, DELETE | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |
| `/api/collection/stats` | GET | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |
| `/api/collection/sync` | POST | Signed `logged_in_customer_id` | `authenticateAppProxyRequest()` | 401 |

## Webhook Authentication Matrix

| Route | Authentication mechanism | Secret |
| --- | --- | --- |
| `/api/webhooks/orders-paid` | Raw-body HMAC | `SHOPIFY_APP_SECRET` |
| `/api/webhooks/orders-cancelled` | Raw-body HMAC | `SHOPIFY_APP_SECRET` |
| `/api/webhooks/refunds-create` | Raw-body HMAC | `SHOPIFY_APP_SECRET` |
| `/api/webhooks/customers-data-request` | Raw-body HMAC | `SHOPIFY_APP_SECRET` |
| `/api/webhooks/customers-redact` | Raw-body HMAC | `SHOPIFY_APP_SECRET` |
| `/api/webhooks/shop-redact` | Raw-body HMAC | `SHOPIFY_APP_SECRET` |

Webhook error contracts and real delivery behavior remain in Phase 4 scope.

## Critical Test Map

| Boundary | Test file | Evidence type |
| --- | --- | --- |
| App Proxy canonical signature, duplicate values, required identity parameters, timestamp window | `tests/unit/hmac.test.ts` | Unit, cryptographic |
| Signature before customer extraction | `tests/unit/session.test.ts` | Unit, trust boundary |
| Every customer route rejects unsigned direct backend calls | `tests/unit/app-proxy-routes.test.ts` | Route regression |
| GraphQL customer filter and application-layer filtering | `tests/unit/customer-isolation.test.ts` | Mock only; real dev-store verification still required |
| Webhook raw-body signature | `tests/unit/hmac.test.ts` | Unit, cryptographic |

## Known Gaps Carried Forward

- Real dev-store two-customer isolation has not yet been executed.
- Real deployed API 401 behavior for every child App Proxy path has not yet been recorded.
- Webhook subscriptions and live deliveries have not yet been verified.
- Batch queue lifecycle and Vercel post-response execution remain unverified.
- GraphQL mutation races and full `userErrors` handling remain unverified.
