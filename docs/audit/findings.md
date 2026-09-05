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
