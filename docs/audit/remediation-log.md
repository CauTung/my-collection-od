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
- Bounded collectible prerequisite lookup to 25 aliases per query and five concurrent queries.
- Mark jobs failed when isolated claim/item failures are recorded.
- Reset progress at admission and count both order-claim and product-upsert work units consistently.
- Made duplicate queued requests share the original admission result and added a failed-state fallback when syncing-state persistence fails.
- Replaced sleep-based 50-item evidence with deterministic 200-item and exact order-claim concurrency tests.
- Recorded item-level retry, 250-line-item pagination, Vercel maximum duration, and React Router adapter compatibility as open gates.

Verification:

- Typecheck: pass after round-one remediation
- Tests: 27 files and 124 tests pass after round-one remediation
- Lint: pass after round-one remediation
- Build: pass; this was the final build before Batch E removed the schema side effect
- Vercel post-response lifecycle: mock only; staging verification pending
- Independent review round 1: six findings; queue admission, failed-state persistence, lookup bounds, and progress semantics remediated; frontend polling assigned to Batch F; documentation corrected
- Independent review round 2: passed; no new P0/P1 backend implementation blocker

## Batch E — GraphQL Resilience and Build Safety

- Date: 2026-09-06
- Findings: AUD-037, AUD-039 through AUD-041
- Scope: Centralized Admin client, exact throttle evidence, side-effect-free build, and official Vercel adapter compatibility

Changes:

- Changed `npm run build` to compile only and introduced explicit `npm run setup:shopify-schema` provisioning.
- Routed the setup script through the same `shopifyGraphQL()` client as runtime operations.
- Added exact retry, backoff, mutation replay, cost wait, and invalid-response tests.
- Aligned React Router packages on 7.18.3, installed the official Vercel preset without peer bypass, and enabled v8 future behavior flags.
- Recorded the remaining moderate transitive dependency advisories as an upstream gate.

Verification:

- Typecheck: exit 0 on 2026-09-07
- Tests: 30 files / 157 tests passed on 2026-09-07
- Lint: exit 0 on 2026-09-07
- Build: exit 0 on 2026-09-07; no schema provisioning executed
- Dependency tree: one deduplicated React Router 7.18.3 tree; no invalid peer dependency
- Independent review: first pass found setup-error swallowing and missing response-envelope validation; second pass confirmed both resolved. Final targeted reconciliation recorded below.


## Batch F ? Frontend Safety and Consolidation

- Date: 2026-09-07
- Findings: AUD-042, AUD-043
- Scope: Shared existing App Proxy renderer, request failure handling, keyboard interaction, and behavioral tests.
- Both page entry routes use the same renderer. Server inline values are escaped; collection data uses DOM text properties.
- Restrict API prefixes to same-origin paths; form limits use shared constants.
- Preserve per-form idempotency UUID on retry and disable duplicate submit immediately.
- Separate successful mutation from failed collection refresh; report pagination/polling refresh errors and suppress concurrent load-more.
- Add initial/restored dialog focus, focus wrapping, and Escape handling.
- Clearing populated optional fields is explicitly rejected before sending a mutation because the current backend does not support that clearing contract. This limitation is visible, not silently accepted.
- Eight executable DOM-harness tests cover the above behavior; the harness is not a real browser.
- Independent review: first-pass crash/clearing findings resolved through error isolation and explicit contract feedback; second static pass found no additional concrete blocker. Real storefront QA remains pending.

## Batch G ? Configuration and Handover Cleanup

- Date: 2026-09-07
- Findings: AUD-044
- Scope: Shared configuration, truthful handover, and test discovery safety.
- Schema/runtime use the same namespace constants. Classification rules, page sizes, and placeholder delays are centralized.
- Corrected an accidental extra page-size argument introduced during the earlier constants move; exact batch concurrency regressions pass.
- Replaced the generic README and misleading environment comments. Integration keys do not enable the mock integrations; Client ID/APP_HOST are operator references.
- Updated architecture and created the staging checklist. Existing React components and mock integrations remain explicitly documented; no unapproved integration was implemented.
- Empty test discovery now fails. Independent review caught the stale allowance and it was removed before final verification.
- Upstream dependency and architecture/external gates remain open; cleanup is not risk acceptance.

## Combined Final Local Verification ? 2026-09-07

All four commands ran from `app-shopify` using `npm.cmd` because PowerShell blocks `npm.ps1`. Each exited 0. The full outputs are retained verbatim:

- [Typecheck](verification/2026-09-07-typecheck.txt)
- [Tests: 30 files / 157 tests](verification/2026-09-07-test.txt)
- [Lint](verification/2026-09-07-lint.txt)
- [Build](verification/2026-09-07-build.txt)

The deprecated `envFile` warning remains non-blocking. No schema provisioning or external deployment was performed in this continuation. Tests use mocks: **C?N VERIFY TR?N DEV STORE TH?T TR??C KHI COI L? XONG**. The owner's own four-command verification and open design decisions are still required.


## Follow-up scope decision ? 2026-09-07

The owner explicitly chose to retain the current MVP data model rather than expand it with event/item contribution Metaobjects. AUD-017, AUD-018, AUD-024, AUD-028, and AUD-034 remain open where their resolution requires that architecture change. This is a scope decision, not acceptance of production data-loss/privacy risk. Continue only in-scope fixes such as historical line-item pagination and aggregate cache validation.

Final E/F/G reconciliation: independent reviewer confirmed no new blocker in the reviewed changes and independently ran 4 relevant test files / 32 tests successfully. All results are local mock/VM evidence.
