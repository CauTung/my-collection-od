# Staging Verification

Status: Staging remains pending after Batch H (2026-09-08). Recorded local verification and independent review do not replace real-store evidence. Local tests use mocked Shopify responses and a simulated browser DOM. No production-readiness claim is made.

## Evidence required before release

For every scenario record UTC timestamp, environment/domain, redacted request ID, expected outcome, actual outcome, and the Shopify/Vercel evidence location. Do not record tokens, signed URLs, or customer personal data.

| Scenario | Exact acceptance | Status |
|---|---|---|
| App Proxy identity | Unsigned/tampered requests return 401; signed storefront page and API work | Pending |
| Customer isolation | Two customers cannot read/update/delete each other's records or cached responses | Pending |
| Admin token | Real token/scopes permit queries; revoked token produces explicit failure | Pending |
| Setup | Explicit schema setup succeeds; normal build performs no Shopify mutation | Build locally verifiable; store pending |
| Webhooks | Real paid/cancel/refund deliveries apply exact quantities under duplicate and reordered events | Pending; attribution/recovery design gates open |
| Privacy | Active/deleted items and claims erased; late delivery cannot recreate erased data | Pending; late-event design gate open |
| Historical sync | Known orders returned for numeric customer filter; exact counts under maximum history and throttling | Pending |
| Queue lifetime | More than the configured job limit all finish within the deployed function duration | Pending |
| Partial failure | Successful sibling item not repeated; failed item recovered on retry | Blocked by AUD-017/AUD-034 architecture decision |
| Large order | Exactly 250 and 251 line items produce exact quantities; continuation failure and the 40-page safety limit fail the affected order before its dedup claim | Fixed locally and independently reconciled in Batch H; staging verification pending |
| GraphQL aliases | Actual store accepts payload sizes; cumulative cost and throttle recovery observed | Pending |
| Dashboard | Real theme renders script, form double-submit is suppressed, keyboard focus and sync polling work | Pending |
| Ownership transfer | Stable production domain and both app identities configured for the intended owner | Pending |

## Required decisions

- Durable item/event contribution or equivalent recovery design for partial paid/sync failure and refund/cancellation attribution.
- Privacy tombstone/late-event policy and operational data-request fulfilment.
- Maximum-duration measurement and supported Vercel configuration; durable continuation if the workload cannot fit.
- Cross-instance quantity concurrency treatment. Historical line-item pagination is implemented and independently reconciled in Batch H; its real-store verification remains pending in the Large order scenario above.
- Review remaining dependency advisories against actual deployed reachability.

These decisions are not silently accepted by the local remediation. No external database, new queue integration, endpoint, or module is authorized by this checklist.

## Final owner verification

The project owner must independently run `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`, and inspect auth, dedup, and customer-isolation code. Record independent review and the real-store evidence before closing the audit.

## Final local review note — 2026-09-08

Local implementation and review are complete. After the owner runs the four commands above, the remaining checklist is staging/deployment evidence plus the architecture and operations decisions listed under Required decisions; there is no known in-scope batch-sync patch left to implement.


## Owner scope decision ? 2026-09-07

The owner chose to keep the current MVP data model. Do not add contribution-ledger Metaobjects, external storage, or durable queue architecture to close the open gates without a later scope change. This decision does not establish that the associated production risks are acceptable.
