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
