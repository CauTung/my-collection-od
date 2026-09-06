# Audit Findings

## AUD-001 — Unsigned Customer API Impersonation

- Severity: P0
- Status: Fixed locally and independently reviewed; deployed dev-store verification pending
- Location: `app/lib/session.server.ts`, all `app/routes/api.collection*.ts`
- Evidence: Before Batch A, customer API routes called `extractAppProxySession()`, which read `logged_in_customer_id` without verifying the App Proxy signature. HMAC verification existed only in dashboard routes.
- Impact: A caller reaching the Vercel backend directly could supply another customer's numeric ID and attempt collection reads or mutations as that customer.
- Reproduction: Before the fix, call a customer API directly with `?logged_in_customer_id={victim_id}` and no signature. The request passed session extraction and reached business logic.
- Root cause: Signature verification and customer extraction were separate operations, so route authors could call only the extraction step.
- Recommendation: Expose a single authentication operation that verifies the full signed query before returning customer context, and use it on every customer route.
- Acceptance:
  - Every direct unsigned customer route returns exact HTTP 401 and `HMAC_INVALID`.
  - Changing `logged_in_customer_id` after signing returns `HMAC_INVALID`.
  - A valid Shopify-signed request returns the normalized customer GID.
  - Repeat the route checks on Vercel through a real Shopify dev store.
- Owner: Batch A implementer
- Independent review: Round 2 confirmed route authentication with no remaining blocker

### Remediation

- Added `authenticateAppProxyRequest()` as the only public customer-session entry point.
- Updated every collection, stats, sync, wishlist, and dashboard route to use it.
- Added route-level unsigned-request regression coverage for seven route entry points.
- Added signed-session and tampered-customer tests.

## AUD-002 — Signed App Proxy Request Replay Window

- Severity: P1
- Status: Fixed locally and independently reviewed; production clock behavior pending verification
- Location: `app/lib/hmac.server.ts`
- Evidence: A correctly signed query was accepted regardless of the age or future value of its `timestamp` parameter.
- Impact: A leaked signed URL could be replayed indefinitely while the application secret remained unchanged.
- Reproduction: Sign a request using an old timestamp and submit it without changing its query values.
- Root cause: The timestamp was included in the HMAC message but had no freshness validation.
- Recommendation: Accept only safe integer timestamps within a documented clock-skew window.
- Acceptance: Requests at ±300 seconds pass; requests beyond that boundary fail with `HMAC_INVALID`.
- Owner: Batch A implementer
- Independent review: Round 2 confirmed timestamp and signature-format behavior

### Remediation

- Added `APP_PROXY_MAX_TIMESTAMP_SKEW_SECONDS` with a five-minute window.
- Added expired, future, and exact-boundary tests.

## AUD-003 — App Proxy Signature Disclosure in Logs

- Severity: P1
- Status: Fixed locally and independently reviewed
- Location: `app/routes/home.tsx`
- Evidence: The root loader logged `url.toString()` and the complete parameter object, both of which contained the App Proxy signature and customer ID.
- Impact: Anyone with log access could replay a signed customer request while it remained accepted.
- Reproduction: Open the App Proxy dashboard and inspect the structured `App Proxy request received` log entry.
- Root cause: Temporary diagnostic logging captured the complete signed URL.
- Recommendation: Log only the pathname and non-sensitive presence booleans.
- Acceptance: No root route log field contains query parameters, signature, or customer ID.
- Owner: Batch A implementer
- Independent review: Round 2 found no remaining blocker

## AUD-004 — Ambiguous Duplicate Identity Parameters

- Severity: P1
- Status: Fixed locally and independently reviewed; deployed verification pending
- Location: `app/lib/hmac.server.ts`
- Evidence: Signature verification supported duplicate values while session extraction collapsed parameters with `Object.fromEntries()`. This allowed different parsing semantics between authentication and authorization layers.
- Impact: Parser disagreement around identity parameters could select a different value than the value a later layer expects.
- Reproduction: Provide multiple `logged_in_customer_id`, `shop`, `path_prefix`, `timestamp`, or `signature` parameters.
- Root cause: Duplicate support was applied uniformly, including identity-bearing fields.
- Recommendation: Preserve Shopify duplicate normalization for additional parameters but require exactly one value for every identity parameter.
- Acceptance: Duplicate additional parameters with a valid signature pass; every duplicated identity parameter fails with `HMAC_INVALID`.
- Owner: Batch A implementer
- Independent review: Round 2 confirmed canonicalization and duplicate handling

## AUD-005 — Cross-Shop App Proxy Authorization

- Severity: P0
- Status: Fixed locally and independently reviewed; deployed verification pending
- Location: `app/lib/session.server.ts`
- Evidence: A valid signature proved that Shopify sent the request but the signed `shop` was not compared with the single shop used by `SHOPIFY_ADMIN_ACCESS_TOKEN`.
- Impact: A request from another shop configured with the same app credentials could operate against the configured store using customer IDs from the other shop.
- Reproduction: Create a correctly signed request with `shop=other-shop.myshopify.com` while the runtime Admin token targets `test-shop.myshopify.com`.
- Root cause: Authentication verified request origin but authorization did not bind the signed tenant to the Admin API tenant.
- Recommendation: Normalize and compare signed `shop` with `SHOPIFY_SHOP_DOMAIN` before returning the customer context.
- Acceptance: A valid HMAC for another shop returns `HMAC_INVALID`; a configured-shop request returns the normalized context.
- Owner: Batch A implementer
- Independent review: Found in round 1; round 2 confirmed remediation with no remaining blocker

## AUD-006 — Cross-Customer Idempotency Response Leak

- Severity: P0
- Status: Fixed locally and independently reviewed
- Location: `app/lib/idempotency.server.ts`, manual create and update routes
- Evidence: The process-wide cache previously used only the client-provided UUID. An authenticated second customer using the same UUID could receive the first customer's cached create response.
- Impact: Cross-customer item disclosure and incorrect request handling.
- Reproduction: Store a completed create result for customer A, then submit the same idempotency UUID as customer B.
- Root cause: Cache identity omitted authenticated customer, operation, and resource scope.
- Recommendation: Build the cache key from authenticated customer ID, operation, resource ID, and client UUID.
- Acceptance: The same UUID used by two customers produces two independent entries and exact customer-specific results; create and update scopes are also independent.
- Owner: Batch A implementer
- Independent review: Found in round 1; round 2 confirmed customer and operation/resource scoping

## AUD-007 — Failed Manual Mutation Leaves Idempotency Claim Stuck

- Severity: P1
- Status: Fixed locally and independently reviewed
- Location: `app/lib/idempotency.server.ts`, manual create and update routes
- Evidence: A claimed key remained in `processing` state when the Shopify create/update mutation threw, so retries returned conflict until TTL expiry.
- Impact: A temporary Shopify failure could block the customer's exact retry for five minutes.
- Root cause: Routes stored successful results but had no failure transition.
- Remediation: Release only a still-processing scoped claim in a catch block, then rethrow the original error.
- Acceptance: First create/update returns 500 from a simulated Shopify failure; the exact signed retry runs the mutation again and returns 201/200.
- Independent review: Round 2 confirmed failure release and completed-result preservation

## AUD-008 — Shopify Mutation Payload Could Be Treated as Success

- Severity: P1
- Status: Fixed locally and independently reviewed
- Location: `app/lib/metaobject.server.ts`
- Evidence: Synced creates ignored `userErrors`; manual creates and updates could accept missing mutation payloads when no top-level GraphQL error was present.
- Impact: Webhooks or manual requests could report success without persisting data.
- Root cause: Mutation result validation was inconsistent across CRUD paths.
- Remediation: Require the expected mutation payload/node and reject every non-empty `userErrors` array.
- Acceptance: Explicit tests cover userErrors and missing payloads for create, sync create, item search, and update.
- Independent review: Round 2 confirmed userErrors and missing-payload handling

## AUD-009 — Same-Product Read-Modify-Write Race

- Severity: P1
- Status: Partially mitigated; distributed-instance decision pending
- Location: `app/lib/metaobject.server.ts`
- Evidence: Two concurrent calls could both read the same quantity or both observe no existing product before writing.
- Impact: Duplicate product records or lost quantity increments.
- Root cause: Shopify metaobject field search and update do not form one atomic increment transaction.
- Remediation: Serialize `customer_id + product_id` upserts within the current process and clean the lock tail in `finally`.
- Acceptance: Concurrent mock test asserts exactly one create, one update, and final quantity 3.
- Residual risk: Separate Vercel instances do not share the lock. A distributed correction would expand architecture beyond the approved zero-external-DB scope and requires a decision gate.
- Independent review: Round 2 confirmed local serialization and retained the cross-instance risk

## AUD-010 — Manual Create Did Not Persist `item_id`

- Severity: P1
- Status: Fixed locally and independently reviewed
- Location: `app/lib/metaobject.server.ts`
- Evidence: `formatFields()` intentionally excludes immutable `item_id`, but manual create used only `formatFields(newItem)` as its field list.
- Impact: The returned item ID was not stored, breaking later mapping and handle-based CRUD behavior.
- Root cause: An update-oriented field formatter was reused for creation without prepending the immutable field.
- Remediation: Explicitly include `item_id` in the create mutation variables.
- Acceptance: The create test asserts the returned item ID exists exactly in Shopify mutation variables.
- Independent review: Round 2 confirmed `item_id` is persisted exactly once

## AUD-011 — Collection Quantity Boundary Not Enforced in Server Module

- Severity: P1
- Status: Fixed locally and independently reviewed
- Location: `app/lib/metaobject.server.ts`
- Evidence: Webhook/batch inputs bypass the manual Zod route schema, and increments could exceed `MAX_QUANTITY_OWNED`.
- Impact: Invalid metaobject values or quantities outside the documented 1..999 business rule.
- Root cause: Quantity validation existed only at the manual HTTP boundary.
- Remediation: Validate initial and resulting quantities in the server module using the shared constant.
- Acceptance: Quantity 0 fails before GraphQL; incrementing 999 by 1 fails after exactly one lookup and no update.
- Independent review: Round 2 confirmed boundary tests exercise the intended paths

## AUD-012 — Webhook Identity Was Not Bound Centrally

- Severity: P0
- Status: Fixed locally; real Shopify delivery verification pending
- Location: `app/lib/webhook.server.ts`, all `app/routes/api.webhooks.*.ts`
- Evidence: Webhook routes previously implemented authentication and payload parsing independently, without one boundary that also checked the sending shop and exact topic.
- Impact: Authentication behavior could drift between routes, and a valid delivery for another route or shop could reach the wrong handler.
- Remediation: Added `authenticateWebhookRequest()` to verify the raw-body HMAC, bind `X-Shopify-Shop-Domain` to the configured shop, bind `X-Shopify-Topic` to the route, and only then parse JSON.
- Acceptance: All six unsigned route requests return exact HTTP 401 and `HMAC_INVALID`; unit tests also cover body tampering, wrong shop, wrong topic, malformed JSON, and array roots.
- Independent review: Final reconciliation found no remaining authentication-boundary blocker

## AUD-013 — App-Specific Webhook Subscriptions Were Missing

- Severity: P0
- Status: Fixed in source; Shopify deploy/release pending
- Location: `app-shopify/shopify.app.toml`
- Evidence: The app configuration did not declare the paid, cancellation, refund, and mandatory compliance webhook subscriptions used by the implemented routes.
- Impact: Route code could be correct while Shopify never delivered the production events.
- Remediation: Declared all six subscriptions, set webhook API version `2026-07`, and added the `read_orders` plus `read_all_orders` scopes required by refund order lookup across the supported history.
- Acceptance: Release the configuration through Shopify CLI, then prove each topic reaches its intended Vercel route using real signed deliveries.
- Independent review: TOML structure reconciled; production release remains AUD-020

## AUD-014 — Refund Webhook Could Silently Skip Customer Orders

- Severity: P1
- Status: Fixed locally; real refund payload verification pending
- Location: `app/lib/order.server.ts`, `app/routes/api.webhooks.refunds-create.ts`
- Evidence: The refund payload handler depended on customer information that is not a reliable top-level refund field and acknowledged the event when it was absent.
- Impact: A normal refund could leave collection quantity unchanged.
- Remediation: Resolve the order customer through the Admin GraphQL API using `order_id`; only guest/deleted-customer orders are skipped.
- Acceptance: Unit tests prove customer and guest-order outcomes; a real dev-store refund must prove the payload and scope behavior.
- Independent review: Local order-resolution path reconciled; real refund remains a staging gate

## AUD-015 — Customer Redaction Was Soft and Incomplete

- Severity: P0
- Status: Fixed locally and independently reconciled; real compliance delivery verification pending
- Location: `app/lib/metaobject.server.ts`, `app/routes/api.webhooks.customers-redact.ts`
- Evidence: The old path only handled active records and used application soft deletion.
- Impact: Personal collection records, including previously soft-deleted entries, could remain after a privacy erasure request.
- Remediation: List active and soft-deleted records by customer, apply an application-side customer check, hard-delete each Metaobject, re-read the first page as the result set shrinks, and return non-2xx on any failed deletion so Shopify retries.
- Acceptance: Unit tests cover inclusion of soft-deleted records, exact delete IDs, and failure propagation; verify against a real dev store before release.
- Independent review: Final reconciliation confirmed item and dedup-lock deletion paths

## AUD-016 — Cancellation Could Arrive Before Paid Processing

- Severity: P1
- Status: Fixed for the sequential delivery case; concurrent cross-instance ordering remains under AUD-009
- Location: `app/lib/dedup.server.ts`, `app/routes/api.webhooks.orders-paid.ts`
- Evidence: A cancellation handled before its paid delivery could be followed by a paid upsert that recreated the cancelled item.
- Impact: Customer collection quantity could include a cancelled purchase.
- Remediation: Paid processing performs an O(1) lookup for the cancellation claim before creating its own claim and upserting items.
- Acceptance: Route test proves a pre-existing cancellation claim prevents both the paid claim and product upsert.
- Independent review: Sequential guard reconciled; broader ordering risks remain AUD-018/AUD-024

## AUD-017 — Partial Webhook Failure Is Permanently Acknowledged

- Severity: P1
- Status: Open — architecture decision required
- Location: paid, cancellation, and refund webhook routes
- Evidence: The event claim is created before item mutations. `Promise.allSettled()` isolates failures, but the route logs rejected items and still returns HTTP 200 while retaining the event claim.
- Impact: A transient failure can permanently omit one item or decrement while Shopify is told the event succeeded. Returning non-2xx without changing the dedup model would also be unsafe because successful siblings could run twice.
- Recommendation: Persist item-level event contributions/status, or introduce a durable replayable job model. This requires a design decision within the zero-external-DB constraint.
- Acceptance: A test with one successful and one failed line item must prove the failed item is eventually applied exactly once without reapplying the successful item.
- Owner: architecture decision gate

## AUD-018 — Refund-Before-Paid Ordering Can Lose the Decrement

- Severity: P1
- Status: Open — architecture decision required
- Location: `app/routes/api.webhooks.refunds-create.ts`, `app/routes/api.webhooks.orders-paid.ts`
- Evidence: If a refund arrives before the corresponding paid item exists, decrement finds nothing and the refund claim is retained; a later paid delivery can then add the full quantity.
- Impact: Refunded products can remain in the customer collection.
- Recommendation: Model immutable per-event contributions or persist pending decrements that paid processing consumes. A process-local lock does not solve delivery across Vercel instances or restarts.
- Acceptance: An integration test delivers refund first and paid second and ends at the exact net quantity.
- Owner: architecture decision gate

## AUD-019 — Customer Data Requests Lack an Operational Fulfilment Path

- Severity: P1
- Status: Open
- Location: `app/routes/api.webhooks.customers-data-request.ts`, owner operating procedure
- Evidence: The route authenticates, logs request metadata, and acknowledges receipt, but does not export the customer's collection data or create a durable operator task.
- Impact: Receiving the mandatory webhook does not by itself fulfil the store owner's privacy response obligation.
- Recommendation: Define the approved export-and-delivery procedure and a durable notification/task mechanism without logging personal data.
- Acceptance: A real data request produces a traceable operator workflow and an exact customer-scoped data export within the required response window.
- Owner: product/operations decision gate

## AUD-020 — Webhook Configuration Is Not Released Yet

- Severity: P0 for launch readiness
- Status: Open until external deployment is completed and verified
- Location: Shopify app version and dev store
- Evidence: `shopify.app.toml` contains the subscriptions locally, but this implementation task did not deploy or release the configuration.
- Impact: The live app may continue using the previous scopes and subscription set.
- Recommendation: Deploy/release the app configuration, approve the changed scope if Shopify requires it, and exercise all six topics on the real dev store.
- Acceptance: Shopify Partner/Dev Dashboard shows the released version and successful signed deliveries to the stable Vercel production domain.
- Owner: deployment operator

## AUD-021 — Privacy Erasure Omitted Dedup Locks

- Severity: P0
- Status: Fixed locally and independently reconciled; real compliance delivery verification pending
- Location: `app/lib/dedup.server.ts`, `app/routes/api.webhooks.customers-redact.ts`
- Evidence: Dedup Metaobjects persist `customer_id` and `external_order_id`, but the first Batch C implementation deleted only collection items.
- Remediation: Customer redaction now lists customer-scoped `collection_dedup_lock` records with an application-side ownership check and permanently deletes them using the same retry-safe first-page loop.
- Acceptance: Unit and route tests prove other-customer locks are excluded and both item and lock pages are re-read until empty.

## AUD-022 — Webhooks Launched Unbounded Mutation Bursts

- Severity: P1
- Status: Fixed locally and independently reconciled; real webhook runtime verification pending
- Location: `app/lib/concurrency.server.ts`, paid/cancellation/refund/customer-redact routes
- Evidence: Routes used one `Promise.allSettled()` across all products or up to 250 privacy deletions.
- Remediation: Added bounded settled mapping and `WEBHOOK_MUTATION_CONCURRENCY = 5` in shared constants.
- Acceptance: Exact test reaches concurrency 5, never more, preserves all results, and continues after a rejected operation.

## AUD-023 — Admin GraphQL Used an Expired Hardcoded API Version

- Severity: P1
- Status: Fixed locally and independently reconciled; real dev-store operation verification pending
- Location: `app/config/constants.ts`, `app/lib/graphql-client.server.ts`
- Evidence: Admin calls used hardcoded `2024-10` while webhook configuration targeted `2026-07`.
- Remediation: Admin API version is now the shared `SHOPIFY_ADMIN_API_VERSION = "2026-07"` constant.
- Acceptance: URL construction test asserts the exact supported version; all affected operations still require real-store execution.

## AUD-024 — Cancellation and Refund Can Double-Decrement One Order

- Severity: P1
- Status: Open — architecture decision required
- Location: cancellation and refund webhook routes
- Evidence: Cancellation subtracts cancelled line quantities under an order cancellation claim while each refund independently subtracts refund quantities under another claim.
- Impact: When both events represent the same units, quantity can be removed twice, including units owned from another order of the same product.
- Recommendation: Persist per-order/per-event quantity contributions and reconcile the exact net effect rather than suppressing one topic heuristically.
- Acceptance: Lifecycle tests cover cancel→refund, refund→cancel, partial refund→cancel, and duplicate deliveries with exact final quantities.
- Owner: architecture decision gate

## AUD-025 — Refund Lookup Could Treat Inaccessible Old Orders as Guests

- Severity: P1
- Status: Fixed in source; access approval/token update and real-store verification pending
- Location: `app/lib/order.server.ts`, `app-shopify/shopify.app.toml`
- Evidence: `read_orders` can be insufficient for orders older than 60 days, and `order: null` was previously acknowledged as if no customer existed.
- Remediation: Added `read_all_orders`; a null/inaccessible order now throws so the webhook returns non-2xx instead of being silently discarded. Only an existing order with `customer: null` is treated as guest/deleted-customer.
- Acceptance: Update the actual app/token scopes and verify a refund lookup against an order older than 60 days.

## AUD-026 — Large Privacy Erasures Depend on Webhook Retry Time Budget

- Severity: P1
- Status: Open — staging measurement and architecture decision required
- Location: `app/routes/api.webhooks.customers-redact.ts`
- Evidence: Mutation concurrency is bounded to five and each successful hard deletion is durable, but a customer with many records can require many sequential chunks before one request completes.
- Impact: The Vercel request can time out. Shopify retries can continue from the remaining first page, but retry count and delivery lifetime place an upper bound on this recovery strategy.
- Recommendation: Measure worst-case deletion duration on staging. If it exceeds the delivery budget, use a durable continuation/job mechanism approved for the zero-external-DB architecture.
- Acceptance: A maximum-size staging customer is fully erased within the documented delivery/retry budget, or a durable continuation test proves eventual deletion after request termination.
- Owner: architecture/staging decision gate

## AUD-027 — Metaobject Field Searches Used an Invalid Real-Shop Contract

- Severity: P0
- Status: Fixed in code, migrated on the configured dev store, and independently reconciled
- Location: `app/lib/metaobject-search.server.ts`, Metaobject query callers, `scripts/setup-metafields.ts`
- Evidence: Queries used `customer_id:'value'` instead of Shopify's `fields.customer_id:"value"` syntax, and searched definition fields did not enable `adminFilterable`. Mocks asserted the invalid query and hid the production failure.
- Impact: Product upsert, collection list, stats, customer isolation, and GDPR deletion could return errors or incorrect result sets on Shopify.
- Remediation: Centralized escaped field-filter construction, updated all Metaobject query callers, enabled filter capabilities on new definitions, and added an idempotent migration plus real query probe for existing definitions.
- Acceptance: Unit tests assert exact syntax and escaping. The configured dev store accepted capability migration for `customer_id`, `product_id`, `is_deleted`, and `in_wishlist`; final build must show both real field-search probes pass.

## AUD-028 — Late Commerce Webhook Can Recreate Redacted Customer Data

- Severity: P2 under Shopify's normal delayed-redaction lifecycle; escalate to P1 if signed webhook bodies can be retained or replayed
- Status: Open — privacy architecture decision required
- Location: customer-redact and paid/refund/cancellation webhook lifecycle
- Evidence: Customer redaction removes items and dedup locks, but there is no durable non-personal marker that prevents a late or replayed valid commerce event from creating a new lock and collection item afterward.
- Impact: Previously erased customer collection data can be recreated after the privacy handler returns success.
- Recommendation: Confirm Shopify delivery-order guarantees and design a privacy-safe suppression mechanism. Retaining the raw customer ID as a tombstone would itself conflict with erasure, so this cannot be solved by copying the deleted identifier into another record.
- Acceptance: Staging lifecycle test delivers a commerce event after redaction and proves no customer-associated data is recreated, using a mechanism approved by privacy/legal owners.
- Owner: privacy/architecture decision gate

## AUD-029 — Queued Batch Jobs Were Never Executed

- Severity: P1
- Status: Fixed locally; independent review pending
- Location: `app/lib/queue.server.ts`, `app/lib/batch-sync.server.ts`
- Evidence: The previous limiter returned `false` at capacity and wrote `queued`, but retained no callback and had no drain path. The client retry assumption did not prove eventual execution.
- Remediation: Added an instance-local FIFO scheduler with a completion promise, automatic drain on settlement, and duplicate-customer coalescing.
- Acceptance: Lifecycle test dispatches 12 jobs against a cap of 10, proves two are initially queued, then proves every queued job starts FIFO and completes at a logical time after dispatch.

## AUD-030 — Batch Sync Used Unregistered Fire-and-Forget Work

- Severity: P1
- Status: Fixed for the Vercel invocation lifecycle; maximum-duration gate remains AUD-036
- Location: `app/lib/background-task.server.ts`, `app/routes/api.collection.sync.ts`
- Evidence: The route returned while an unobserved promise continued in memory, allowing the serverless runtime to freeze or terminate it.
- Remediation: Register the scheduler's complete queued-to-terminal promise with official Vercel `waitUntil`; local/test execution observes the same promise in-process.
- Acceptance: Unit test proves Vercel registration receives the observed promise; staging must prove work continues after HTTP 202.

## AUD-031 — Sync Trigger Failure Was Disguised as HTTP 200

- Severity: P1
- Status: Fixed locally; independent review pending
- Location: `app/routes/api.collection.sync.ts`
- Evidence: A route-local catch returned `{success:false}` with HTTP 200 for scheduler or Admin state failures.
- Impact: Frontend and monitoring could treat a failed trigger as a successful request.
- Remediation: Removed the catch and let `withErrorHandler()` return the standard HTTP 500 contract.
- Acceptance: Route test asserts exact 500 `INTERNAL_ERROR` and no background registration.

## AUD-032 — Batch Claims Were Created Before Product Prerequisites

- Severity: P1
- Status: Fixed locally; item-level mutation recovery remains AUD-034
- Location: `app/lib/batch-sync.server.ts`
- Evidence: Orders were claimed before the shared collectible metafield lookup; a transient lookup failure permanently skipped those orders on retry.
- Remediation: Collect and classify line items first, then claim only orders containing valid collectible items using bounded concurrency.
- Acceptance: Test forces product lookup failure and proves zero claim calls plus terminal failed status.

## AUD-033 — Historical Order Search Used a Customer GID Where Shopify Expects Numeric ID

- Severity: P0
- Status: Fixed locally; real historical query verification pending
- Location: `app/lib/shopify-id.server.ts`, `app/lib/batch-sync.server.ts`
- Evidence: The order search expression interpolated `gid://shopify/Customer/...` into `customer_id`, which uses Shopify's numeric customer ID filter.
- Remediation: Added strict shared Shopify ID normalization and emit `customer_id:123` from an authenticated customer GID.
- Acceptance: Unit test asserts the query starts with the exact numeric filter and contains no customer GID; staging must execute it against known historical orders.

## AUD-034 — Batch Item Failure Remains Locked by Order Dedup

- Severity: P1
- Status: Open — architecture decision required
- Location: `app/lib/batch-sync.server.ts`, `app/lib/dedup.server.ts`
- Evidence: Each order claim is durable before its product upserts. A rejected product increments `failed` and marks the job failed, but retry skips the already-claimed order.
- Impact: A transient mutation failure can permanently omit an item even though the UI truthfully reports job failure.
- Recommendation: Persist item-level event contributions/status or implement a durable replayable job model; returning/retrying at order granularity can double-apply successful sibling products.
- Acceptance: A test with one successful and one failed product retries and reaches the exact final state without incrementing the successful product twice.
- Owner: architecture decision gate

## AUD-035 — Orders With More Than 250 Line Items Are Truncated

- Severity: P2
- Status: Open
- Location: historical orders GraphQL query
- Evidence: Each nested `lineItems(first: 250)` connection omits `pageInfo` and has no continuation query.
- Impact: Extremely large orders can be only partially synchronized.
- Recommendation: Confirm the business maximum order size; add per-order pagination if 250 is not a guaranteed upper bound.
- Acceptance: Boundary test with 251 line items either rejects by documented business rule or processes the final item through pagination.

## AUD-036 — Vercel Maximum Duration Can Still Terminate Batch Work

- Severity: P1
- Status: Open — staging/deployment decision required
- Location: Vercel function configuration and historical sync lifecycle
- Evidence: `waitUntil` attaches work after response but does not extend it beyond the Function's configured maximum duration.
- Impact: Slow Shopify responses or maximum-size history can leave status `syncing` and queued jobs unfinished.
- Recommendation: Measure the 200-order worst case on the target Vercel plan and configure a supported duration; use durable continuation if the bound cannot be guaranteed.
- Acceptance: Staging evidence proves terminal state within the configured duration under throttling, or a durable resume test proves recovery after termination.
- Owner: deployment/architecture decision gate

## AUD-037 — Official Vercel React Router Preset Has a Major-Version Peer Conflict

- Severity: P1 for deployment readiness
- Status: Open for Batch E
- Location: `react-router.config.ts`, package versions
- Evidence: Project uses React Router 8.3.1, while the currently resolved `@vercel/react-router@1.3.6` package declares peer `@react-router/dev@7`; installation failed with `ERESOLVE` and was not forced.
- Impact: The project still lacks the recommended Vercel preset/function-level configuration path.
- Recommendation: Decide whether to align on React Router 7 or wait for/use a verified adapter supporting 8; do not bypass the peer contract with `--force`.
- Owner: Batch E decision gate

## AUD-038 — Batch Concurrency Was Tested Against the Wrong Work Unit

- Severity: P1
- Status: Fixed locally; independent review pending
- Location: `tests/unit/batch-sync-integration.test.ts`
- Evidence: The earlier test measured product upserts, used only 50 records despite claiming a 200-order scale test, and asserted only `> 0` plus `<= 5`.
- Remediation: The scale test now uses exactly 200 items and asserts exact concurrency 5; a separate controlled test proves order claims also reach exactly concurrency 5 after prerequisites.
- Acceptance: Both exact assertions pass without timing-based sleeps.
