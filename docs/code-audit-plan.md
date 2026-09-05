# Code Audit Plan

## 1. Objective

This plan defines how to audit the Shopify application before further feature work or a production-readiness claim. The audit must produce reproducible evidence, prioritized findings, and small remediation batches.

The audit covers:

- App Proxy, webhook, and Admin API authentication
- Customer data isolation
- Metaobject and metafield correctness
- Webhook and batch-sync idempotency
- GraphQL reliability and rate-limit handling
- Vercel/serverless execution constraints
- Frontend security and request contracts
- Hardcoded configuration, duplication, dead code, and documentation drift
- Automated tests and real Shopify dev-store verification

The audit does not authorize unrelated features or architecture expansion. Any proposed Redis queue, external database, new integration, or new endpoint must be reviewed as a separate scope decision.

## 2. Audit Rules

1. Audit before refactoring. Record the failing behavior and evidence before changing implementation.
2. Never include secrets or full access tokens in reports, screenshots, fixtures, or command output.
3. Every finding must include a file and line reference, impact, reproduction method, and acceptance test.
4. Mock tests are supporting evidence only. Shopify-facing behavior is not considered verified until it passes on a real dev store.
5. Each remediation batch must run all four required checks:
   - `npm run typecheck`
   - `npm test`
   - `npm run lint`
   - `npm run build`
6. Architecture, data-flow, exception-handling, or performance changes must update `docs/architecture-overview.md` in the same batch.
7. A different reviewer must review every remediation batch. The original implementer must not be the only person or agent declaring it complete.

## 3. Severity Model

| Severity | Meaning | Examples | Release rule |
| --- | --- | --- | --- |
| P0 | Direct security boundary failure or likely cross-customer data exposure | Unsigned API request can impersonate a customer; secret leakage | Stop release and fix first |
| P1 | Data loss, duplication, incorrect ownership, broken production workflow, or unbounded operational failure | Lost quantity updates, non-functional queue, webhook retry corruption | Must fix before production |
| P2 | Important resilience, maintainability, performance, or UX defect | Missing pagination, build-time mutation, duplicated dashboard implementation | Fix before handover unless explicitly accepted |
| P3 | Low-risk cleanup or documentation drift | Naming inconsistency, stale comments, minor dead code | Schedule after higher priorities |

## 4. Required Finding Format

Each finding must use this structure:

```text
ID: AUD-XXX
Severity: P0 | P1 | P2 | P3
Status: Open | Confirmed | Fixed | Accepted risk | Not reproducible
Location: relative/path.ts:line
Evidence: command output, test name, request/response, or code path
Impact: concrete user, data, security, or operational effect
Reproduction: deterministic steps
Root cause: technical explanation
Recommendation: smallest in-scope correction
Acceptance: exact automated and/or dev-store test
Owner: person or agent responsible for remediation
Independent review: reviewer and result
```

Audit artifacts should be stored under `docs/audit/` once execution begins:

```text
docs/audit/
  baseline.md
  findings.md
  staging-verification.md
  remediation-log.md
```

Do not store raw environment dumps in this directory.

## 5. Current Seed Risks

These are starting hypotheses from the initial repository inspection. They are not closed findings until reproduced and recorded using the format above.

| Seed ID | Priority | Area | Initial evidence to verify |
| --- | --- | --- | --- |
| SEED-001 | P0 | App Proxy authorization | Child API routes extract `logged_in_customer_id`, while HMAC verification appears to occur only in the page route. Test whether direct unsigned requests can access or mutate another customer's data. |
| SEED-002 | P1 | Batch queue | Capacity overflow is reported as `queued`, but no durable or in-process queue lifecycle has yet been identified. Verify that queued jobs actually start and finish. |
| SEED-003 | P1 | Serverless background work | Batch processing appears to continue after the HTTP response. Verify whether Vercel can terminate the work before completion. |
| SEED-004 | P1 | Metaobject upsert | Product lookup followed by create/update may race. Concurrent orders for the same customer and product may duplicate items or lose quantity increments. |
| SEED-005 | P1 | Partial batch failure | An order may be claimed before all its items finish, potentially making a failed item impossible to retry. |
| SEED-006 | P1 | GraphQL mutation handling | Some create/update paths appear not to reject all Shopify `userErrors`. |
| SEED-007 | P2 | Build side effects | The build script runs `scripts/setup-metafields.ts`, which may mutate Shopify during every local or Vercel build. |
| SEED-008 | P2 | GraphQL policy | The setup script calls Admin GraphQL with direct `fetch()` rather than the shared retrying client. |
| SEED-009 | P2 | Configuration | API versions, metaobject types, namespaces, pagination sizes, and timeouts appear outside `config/constants.ts`. |
| SEED-010 | P2 | Error contracts | Some API routes appear to convert infrastructure failures into HTTP 200 responses or empty data. |
| SEED-011 | P2 | Frontend security | The inline HTML/JavaScript dashboard may insert Shopify or user-controlled values without a single contextual escaping policy. |
| SEED-012 | P2 | Duplication | `home.tsx` and `app.my-collection.tsx` contain overlapping dashboard HTML, CSS, and JavaScript. |
| SEED-013 | P2 | Shopify configuration | TOML scopes, webhook subscriptions, callback routes, and API versions may not match the implemented application behavior. |
| SEED-014 | P2 | Pagination and access scopes | Historical order and line-item limits must be checked against pagination and `read_all_orders` requirements. |
| SEED-015 | P3 | Project handover | The root README is still generic and does not describe the actual application lifecycle. |

## 6. Execution Order

### Phase 0 — Reproducible Baseline

Goal: capture the current state without changing application behavior.

Checks:

- Record the current branch, commit, and changed files without discarding user changes.
- Inventory every route, server module, GraphQL operation, environment variable, webhook topic, metaobject type, metafield namespace, and external integration.
- Run the four required verification commands and save their complete output.
- Run test coverage and map each critical module to its tests.
- Identify generated files and confirm that secrets are ignored by Git.
- Record the Vercel production domain, project root directory, and Shopify app configuration using redacted values.

Deliverables:

- `docs/audit/baseline.md`
- Initial route/authentication matrix
- Initial test-coverage matrix

Exit criteria:

- Another developer can reproduce the baseline locally.
- No token, client secret, or customer personal data appears in the artifacts.

### Phase 1 — Trust Boundaries and Customer Isolation

Goal: prove that no unauthenticated or cross-customer request can read or mutate collection data.

Files and paths to inspect first:

- `app/lib/hmac.server.ts`
- `app/lib/session.server.ts`
- `app/routes/api.collection.ts`
- `app/routes/api.collection.$itemId.ts`
- `app/routes/api.collection.sync.ts`
- `app/routes/app.my-collection.tsx`
- All webhook routes

Checks:

- Build a route matrix showing which signature, secret, token, and customer identifier protects each route.
- Send unsigned, tampered, duplicated-parameter, stale-timestamp, and valid App Proxy requests to every customer-facing API route.
- Prove that the customer identity comes only from a verified Shopify request, never from an unsigned query or request body.
- Create two customers with separate items and prove read, update, delete, sync, and stats isolation.
- Verify webhook HMAC against the raw request body and reject altered bodies.
- Decide and document a timestamp/replay policy for App Proxy requests.
- Verify that logs and error responses do not expose tokens, secrets, raw HMAC values, or customer data.

Required acceptance tests:

- Direct backend request without a signature returns `401`.
- A valid signature with a changed customer ID returns `401`.
- Customer A cannot read, update, or delete Customer B's item.
- A malformed duplicate query parameter cannot bypass signature verification.
- Existing valid App Proxy requests still render successfully.

Exit criteria:

- All P0 authentication and customer-isolation findings are fixed and independently reviewed.
- The same scenarios pass against a deployed dev-store environment.

### Phase 2 — Shopify Identity, Token, and Portable Configuration

Goal: make the two Shopify application identities explicit and make ownership transfer repeatable.

Checks:

- Confirm the Partner/Dev Dashboard app owns the App Proxy configuration and provides `SHOPIFY_CLIENT_ID` and `SHOPIFY_APP_SECRET`.
- Confirm the Legacy custom app provides only `SHOPIFY_ADMIN_ACCESS_TOKEN` for the current Admin GraphQL design.
- Confirm the custom-app token has the exact scopes required by implemented queries and mutations.
- Compare required scopes with `shopify.app.toml`, including order history requirements.
- Verify whether the configured OAuth callback route exists. Remove stale configuration or implement only if OAuth is an approved scope change.
- Align Shopify API versions across TOML, runtime GraphQL calls, tests, and setup scripts.
- Replace repository-specific domains and identifiers with documented placeholders where portability requires it.
- Verify that Preview deployment URLs are never used as stable Shopify callback or App Proxy targets.

Exit criteria:

- A new owner can configure the app using `docs/setup-new-shopify-vercel-owner.md` without copying the previous owner's credentials or deployment URL.
- Every environment variable has one documented owner, purpose, and validation rule.

### Phase 3 — Metaobject and Metafield Data Correctness

Goal: prove idempotent and customer-safe data behavior under retries and concurrency.

Checks:

- Verify canonical handles:
  - Dedup lock: `dedup-{customer_id}-{order_id}`
  - Collection item: `{customer_id}-{item_id}`
- Verify webhook and batch dedup use atomic create-and-catch behavior.
- Test two simultaneous paid orders containing the same product for one customer.
- Test simultaneous quantity increments and detect lost updates.
- Ensure every mutation checks all Shopify `userErrors` and expected response nodes.
- Verify manual Add/Edit idempotency keys are scoped correctly and failed operations can be retried.
- Verify delete, cancellation, and refund behavior against the agreed business rules.
- Verify numeric parsing, currency, quantity, purchase date, grading, notes, and certificate boundaries.
- Verify cached aggregate stats after create, update, delete, webhook, refund, cancellation, and partial failure.
- Verify pagination for collection records and maintenance operations.

Exit criteria:

- Concurrent and repeated requests produce exact expected quantities and record counts.
- No test relies only on a loose upper-bound assertion.

### Phase 4 — Webhook Lifecycle and GDPR Routes

Goal: verify authentic, retry-safe, observable webhook processing.

Checks:

- Map implemented webhook routes to Shopify subscriptions and deployed URLs.
- Test `orders/paid`, `orders/cancelled`, and `refunds/create` using real payload shapes.
- Test duplicate delivery, out-of-order delivery, missing customer, non-collectible items, and partial GraphQL failure.
- Confirm duplicate-handle errors are swallowed only where idempotency requires it; all unexpected failures must surface for retry.
- Verify `customers/data_request`, `customers/redact`, and `shop/redact` behavior and response timing.
- Verify redaction pagination and strict customer/shop boundaries.
- Ensure all routes follow the shared error-handling contract or document a webhook-specific exception.

Exit criteria:

- Real Shopify webhook deliveries are visible in logs and produce the exact expected data changes.
- Retried delivery neither duplicates nor loses data.

### Phase 5 — Batch Sync, Queue, and Serverless Runtime

Goal: prove that every accepted sync job reaches a terminal state without exceeding limits.

Checks:

- Model the full lifecycle: request, admission, queued state, running state, item failures, completion, and retry.
- Prove that queued jobs run later; a label of `queued` alone is insufficient.
- Test at least `MAX_CONCURRENT_BATCH_SYNC_JOBS + 2` simultaneous jobs and record dispatch and completion timestamps.
- Assert per-job active work stays between 4 and 5 when enough work exists.
- Verify aggregate concurrency behavior across multiple jobs.
- Confirm whether Vercel permits the selected background execution model after the response ends.
- Verify order and line-item pagination, lookback boundaries, and required Shopify access scopes.
- Test partial order failure and prove a retry processes only unfinished work.
- Test GraphQL throttling during a batch without stopping unrelated items.
- Confirm progress polling and terminal error reporting are accurate.

Decision gate:

- If the current serverless design cannot guarantee execution after the response, stop remediation and present in-scope options before introducing a new queue service or database.

Exit criteria:

- Every accepted or queued job has a proven terminal state.
- No failed item is permanently hidden by an order-level dedup claim.

### Phase 6 — GraphQL Reliability, Cost, and Performance

Goal: centralize Admin API behavior and validate Shopify rate-limit assumptions.

Checks:

- Inventory direct Admin API `fetch()` calls; all runtime calls must use `shopifyGraphQL()`.
- Test HTTP `429`, GraphQL `THROTTLED`, malformed JSON, network failure, missing response data, and exhausted retries.
- Verify exponential backoff uses constants and stops after the exact configured attempt count.
- Classify mutations as safe or unsafe to retry and prevent accidental duplicate writes.
- Calculate alias-batched request cost as the sum of all operations.
- Determine Shopify limits for alias count, query size, requested cost, and actual cost on the target API version.
- Ensure all dynamic GraphQL values use variables.
- Verify dashboard stats read cached customer metafields without scanning all metaobjects.
- Record every justified list scan and its pagination behavior.

Exit criteria:

- Each GraphQL operation has an owner, named operation, variables, typed response, error behavior, and test.
- Real dev-store throttling metadata matches the application's cost assumptions.

### Phase 7 — Frontend Security and Request Contracts

Goal: remove injection risks and align the visible interface with implemented backend behavior.

Checks:

- Trace every Shopify-controlled and user-controlled value inserted into HTML, attributes, CSS, URLs, and inline JavaScript.
- Add context-appropriate escaping and regression tests for quotes, tags, script terminators, and malicious URLs.
- Compare inline dashboard code with existing React components and select one implementation path.
- Verify Add/Edit form wiring, per-form UUID idempotency keys, immediate submit disabling, retry behavior, and accessible error feedback.
- Verify loading, empty, partial-error, queued, completed, and authentication-expired states.
- Confirm browser requests preserve the signed App Proxy context or use an independently authenticated contract.
- Check accessibility for dialog focus, labels, keyboard actions, and status messages.

Exit criteria:

- Stored text cannot execute code in the dashboard.
- UI states accurately represent backend terminal and retry states.

### Phase 8 — Hardcode, Duplication, Dead Code, and Documentation

Goal: make configuration intentional and reduce maintenance risk without broad rewrites.

Checks:

- Inventory numeric limits, timeouts, API versions, namespaces, types, routes, and integration endpoints outside `app/config/constants.ts`.
- Classify each value as configuration, business rule, protocol literal, UI copy, or test fixture before moving it.
- Identify duplicated helper logic, GraphQL fragments, GID parsing, serializers, dashboard markup, and validation rules.
- Identify unused routes, components, integrations, environment variables, and dependencies.
- Review Yotpo and Klaviyo modules against the approved MVP scope; do not complete placeholder integrations without authorization.
- Replace the generic README with project-specific development, test, deploy, and ownership-transfer instructions.
- Align architecture documentation with the final code paths.

Exit criteria:

- There is one authoritative location for each shared configuration value and business rule.
- Dead code removal is supported by route/import/test evidence.

### Phase 9 — Real Dev-Store Staging Verification

Goal: validate behavior that mocks and local execution cannot prove.

Required scenarios:

- Install/configure using a fresh Partner app, fresh Legacy custom app token, and stable Vercel production domain.
- Verify valid and invalid App Proxy requests.
- Create two test customers and prove complete data isolation.
- Deliver real paid, cancelled, refund, and GDPR webhooks.
- Run historical sync with enough orders/items to exercise pagination and concurrency.
- Trigger or observe GraphQL throttling and confirm recovery.
- Validate alias batching against real Shopify complexity limits.
- Redeploy Vercel and confirm no unexpected Shopify schema mutation occurs during build.
- Rotate or revoke the Admin token and verify a clear operational failure rather than silent empty data.

Deliverable:

- `docs/audit/staging-verification.md` with timestamps, redacted request identifiers, expected results, actual results, and Vercel/Shopify evidence references.

Exit criteria:

- All P0 and P1 findings are closed.
- Remaining P2/P3 findings are either closed or explicitly accepted by the project owner.
- An independent reviewer completes a second pass after remediation.
- The human project owner runs the four verification commands and inspects auth, dedup, and customer-isolation code.

## 7. Recommended Remediation Batches

Keep each batch independently reviewable and deployable:

1. **Batch A — P0 customer authentication**
   - App Proxy verification for every customer API request
   - Cross-customer route tests
   - Timestamp/replay decision
2. **Batch B — Mutation correctness**
   - GraphQL `userErrors`
   - Manual idempotency lifecycle
   - Concurrent same-product upsert
3. **Batch C — Webhook correctness**
   - Subscription/config alignment
   - Duplicate and out-of-order delivery tests
   - Refund/cancellation behavior
4. **Batch D — Batch-sync lifecycle**
   - Queue behavior
   - Serverless execution decision
   - Partial-failure retries and pagination
5. **Batch E — GraphQL resilience and build safety**
   - Centralized client usage
   - Backoff/cost tests
   - Remove deployment-time schema side effects from the normal build
6. **Batch F — Frontend safety and consolidation**
   - Contextual escaping
   - Add/Edit request contract
   - Dashboard duplication
7. **Batch G — Configuration and handover cleanup**
   - Constants and environment validation
   - README and architecture alignment
   - Dead code and dependency removal

Do not combine Batch A with broad frontend or cleanup refactoring. Security behavior must remain easy to review and test independently.

## 8. Definition of Audit Complete

The audit is complete only when:

- Every route and GraphQL operation appears in an inventory.
- Every seed risk is converted to a confirmed finding or closed as not reproducible with evidence.
- All P0 and P1 findings have exact regression tests and real dev-store verification where applicable.
- Each remediation batch includes complete output from typecheck, tests, lint, and build.
- Architecture and setup documentation match deployed behavior.
- No audit artifact contains secrets or customer personal data.
- Independent first and second reviews are recorded.
- The human project owner completes the required final verification.

## 9. Immediate Next Audit Session

Start with Phase 0 and Phase 1 only:

1. Create the baseline and route/authentication matrix.
2. Reproduce whether unsigned direct API requests can supply an arbitrary `logged_in_customer_id`.
3. Add the confirmed result as the first formal finding.
4. Prepare Batch A with narrow regression tests before modifying production logic.

Do not begin general hardcode cleanup until the P0 trust-boundary result is understood and protected by tests.
