# Remediation Log

## Batch A — App Proxy Customer Authentication

- Date: 2026-09-05
- Findings: AUD-001, AUD-002, AUD-003, AUD-004, AUD-005, AUD-006
- Scope: Customer-facing App Proxy trust boundary only

Changes:

- Centralized signature verification and customer context extraction.
- Applied authentication to all collection, stats, sync, wishlist, and dashboard routes.
- Enforced a five-minute signed timestamp window.
- Rejected duplicate identity parameters while preserving Shopify duplicate normalization for additional parameters.
- Removed complete signed URLs and query objects from root-route logs.
- Bound the signed App Proxy shop to the shop configured for the Admin token.
- Scoped idempotency entries by customer, operation, resource, and client UUID.
- Added HMAC, session, and route regression tests.
- Updated `docs/architecture-overview.md`.

Verification:

- Typecheck: pass
- Tests: 11 files and 66 tests pass
- HMAC coverage: 100% statements, branches, functions, and lines
- Lint: pass
- Build: pass
- Real dev store: pending
- Independent review round 1: two blockers found and remediated
- Independent review round 2: both blockers reconciled; no remaining security/correctness blocker in Batch A

## Batch B — Mutation Correctness

- Date: 2026-09-05
- Findings: AUD-007, AUD-008, AUD-009, AUD-010, AUD-011
- Scope: Manual mutation retry lifecycle and collection-item mutation correctness

Changes:

- Release failed create/update idempotency claims without deleting completed results.
- Added route tests proving the exact failed request can retry.
- Reject synced create `userErrors` and missing create/update/search payloads.
- Persist immutable `item_id` during manual creation.
- Validate quantity boundaries in the server module for manual, webhook, and batch callers.
- Serialize same-customer/product upserts within one server instance.
- Added exact concurrent test: one create, one update, final quantity 3.
- Moved the collection-item metaobject type to shared constants.

Verification:

- Typecheck: pass
- Tests: 13 files and 79 tests pass
- Lint: pass
- Build: pass; current build still runs the separately tracked Shopify schema setup side effect
- Real dev store: pending
- Independent review round 1: no blockers; cross-instance race recorded as residual architecture risk
- Independent review round 2: one constants-source blocker found in stats and remediated
- Independent follow-up: constants-source blocker confirmed closed with no regression

## Batch C — Webhook Lifecycle and Privacy Boundaries

- Date: 2026-09-05
- Findings: AUD-012 through AUD-028
- Scope: Shopify webhook authentication, registration, refund/cancellation handling, and privacy erasure

Changes:

- Centralized raw-body HMAC, configured-shop, exact-topic, and JSON-object validation for all six webhook routes.
- Declared paid, cancellation, refund, and compliance subscriptions in `shopify.app.toml`; added `read_orders` for refund order lookup.
- Resolve refund customer identity through the order GraphQL query.
- Delay the paid event claim until read-only product prerequisites succeed.
- Prevent sequential paid processing after an already-processed cancellation.
- Serialize same-customer/product decrements within one process.
- Hard-delete active and soft-deleted customer collection Metaobjects and propagate deletion failures for Shopify retry.
- Hard-delete customer-owned dedup locks, bound webhook mutations to five concurrent operations, and moved Admin GraphQL to the shared `2026-07` version.
- Request `read_all_orders` and reject inaccessible order responses instead of silently classifying them as guest orders.
- Correct Shopify Metaobject searches to escaped `fields.{key}:"value"`, migrate all searched fields to `adminFilterable`, and probe the query contract against the configured dev store during setup.
- Record late-commerce-event recreation after privacy redaction as an explicit privacy design gate.
- Added webhook boundary, route authentication, order lookup, ordering, decrement concurrency, and privacy deletion tests.
- Recorded partial-failure recovery, refund-before-paid ordering, data-request operations, and production configuration release as open gates.

Verification:

- Typecheck: pass in final verification
- Tests: 22 files and 108 tests pass in final verification; independently rerun with the same result
- Lint: pass in final verification
- Build: pass; setup confirmed both `adminFilterable` migrations already enabled and both real Metaobject field-search probes succeeded on the configured dev store
- Real dev store: schema capability migration/query probe passed; real webhook delivery and lifecycle staging scenarios remain pending
- Independent review round 1: six blockers found; four remediated in code/tests, cancellation/refund attribution remains an explicit P1 design gate, and real-store scope/release verification remains open
- Independent review round 2: found invalid mocked Metaobject search syntax and missing `adminFilterable` capabilities; remediation migrated the configured dev store and added real query probes
- Independent final reconciliation: AUD-015, AUD-021, AUD-022, AUD-023, and AUD-027 locally closed; no new P0/P1 implementation blocker beyond the explicitly open decision/external gates

## Batch D — Historical Sync Lifecycle

- Date: 2026-09-06
- Findings: AUD-029 through AUD-038
- Scope: Instance-local scheduling, serverless background lifetime, order prerequisites, and concurrency evidence

Changes:

- Replaced the counter-only limiter with a FIFO scheduler that retains queued jobs, drains after settlement, and coalesces duplicate customer requests.
- Exposed one completion promise spanning queued dispatch through terminal execution.
- Registered completion with Vercel `waitUntil` and removed route-level HTTP 200 error masking.
- Normalized authenticated customer GIDs to numeric Shopify order-filter values.
- Moved collectible-data lookup before atomic order claims and bounded claim concurrency at five.
- Mark jobs failed when isolated claim/item failures are recorded.
- Replaced sleep-based 50-item evidence with deterministic 200-item and exact order-claim concurrency tests.
- Recorded item-level retry, 250-line-item pagination, Vercel maximum duration, and React Router adapter compatibility as open gates.

Verification:

- Typecheck: pass before independent review
- Tests: 26 files and 119 tests pass before independent review
- Lint: pass before independent review
- Build: pending final verification
- Vercel post-response lifecycle: mock only; staging verification pending
- Independent review: pending
