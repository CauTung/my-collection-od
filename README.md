# Downies ? My Collection

Shopify storefront collection app using React Router and Shopify Metaobjects/Customer Metafields. The runtime uses no external database. Audit remediation is in progress; this repository is not yet cleared for production.

## Local development

Run commands from `app-shopify` (Node and npm versions must satisfy `package-lock.json`):

```powershell
Set-Location app-shopify
npm ci
Copy-Item .env.example .env
npm run dev
```

Fill `.env` locally. Never commit credentials. The runtime requires `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_APP_SECRET`. The Admin access token authorizes GraphQL; the app secret verifies signed App Proxy and webhook requests. A local browser request does not substitute for a signed storefront request.

## Verification

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

On Windows with PowerShell script execution disabled, use `npm.cmd` for the same commands. Unit tests use mocks; passing them does not prove Shopify permissions, search, webhook delivery, or Vercel background lifetime.

`npm run build` only compiles. `npm start` locates and serves the single generated server bundle. Schema provisioning is a separate, store-mutating operation: after confirming the intended store and token, run `npm run setup:shopify-schema`. Runtime and setup share namespace constants in `app/config/constants.ts`; changing a namespace on an existing store requires a data migration decision.

## Deployment and ownership transfer

Use Vercel Root Directory `app-shopify`, set runtime credentials in Vercel Environment Variables, and configure Shopify with a stable Production/custom domain. Vercel deployment and `npx shopify app deploy` release different artifacts: application code and Shopify configuration respectively. Follow [the owner setup guide](docs/setup-new-shopify-vercel-owner.md), including the existing two-app credential design and its portability constraints.

The configured application is a storefront App Proxy workflow. Do not assume an embedded Admin installation or token acquisition flow exists. Verify the real storefront proxy and webhook delivery after deployment.

## Code and audit map

- `app-shopify/app/routes.ts`: explicit route registry.
- `app-shopify/app/lib/dashboard-html.server.ts`: shared storefront HTML renderer.
- `app-shopify/app/lib/graphql-client.server.ts`: sole Admin GraphQL client.
- `app-shopify/app/config/constants.ts`: shared limits, classification rules, and namespaces.
- `app-shopify/tests/unit`: TypeScript regression tests.
- [Architecture](docs/architecture-overview.md), [audit findings](docs/audit/findings.md), [remediation log](docs/audit/remediation-log.md), and [staging checklist](docs/audit/staging-verification.md).

Yotpo and Klaviyo modules are placeholders and do not call external APIs, even if integration credentials are supplied. The retained React components are not the active storefront renderer. They are not evidence of a second working dashboard.

Release gates include item-level recovery after partial sync failure, cross-instance quantity races, refund/cancellation attribution, privacy late-event behavior, historical line-item pagination, Vercel duration measurements, and real dev-store verification. See the audit findings for exact status. Independent review and the owner's own four-command verification are required before release.
