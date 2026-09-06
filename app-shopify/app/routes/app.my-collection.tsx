/** Shopify App Proxy entry point for the shared collection dashboard fragment. */

import type { LoaderFunctionArgs } from "react-router";
import { buildDashboardHtml } from "~/lib/dashboard-html.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { authenticateAppProxyRequest } from "~/lib/session.server";

export const loader = withErrorHandler(async ({ request }: LoaderFunctionArgs) => {
  const session = authenticateAppProxyRequest(request);
  return new Response(buildDashboardHtml(session.path_prefix), {
    status: 200,
    headers: { "Content-Type": "application/liquid" },
  });
});
