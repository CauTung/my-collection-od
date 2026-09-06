/** Root App Proxy target plus a minimal direct-access information response. */

import type { LoaderFunctionArgs } from "react-router";
import { buildDashboardHtml } from "~/lib/dashboard-html.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { logger } from "~/lib/logger.server";
import { authenticateAppProxyRequest } from "~/lib/session.server";

export const loader = withErrorHandler(async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const isAppProxy = url.searchParams.has("signature");

  logger.info("Root request received", {
    pathname: url.pathname,
    isAppProxy,
    hasShop: url.searchParams.has("shop"),
    hasCustomerId: Boolean(url.searchParams.get("logged_in_customer_id")),
  });

  if (!isAppProxy) {
    return new Response(
      "<html><body><h1>Downies My Collection App</h1><p>This app is accessed through the Shopify storefront.</p></body></html>",
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  }

  const session = authenticateAppProxyRequest(request);
  return new Response(buildDashboardHtml(session.path_prefix), {
    status: 200,
    headers: { "Content-Type": "application/liquid" },
  });
});
