/**
 * app/routes/api.collection.stats.ts
 *
 * GET: Fetches the cached stats and sync status for the authenticated customer.
 */

import { type LoaderFunctionArgs } from "react-router";
import { extractAppProxySession } from "~/lib/session.server";
import { getCustomerCollectionMetafields } from "~/lib/metafield.server";
import { withErrorHandler } from "~/lib/error-handler.server";

async function loaderHandler({ request }: LoaderFunctionArgs) {
  const session = extractAppProxySession(request);

  // Fast-path: read from Customer Metafields cache
  const { stats, syncState } = await getCustomerCollectionMetafields(session.customer_id);

  return new Response(JSON.stringify({
    success: true,
    data: {
      stats,
      syncState,
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

export const loader = withErrorHandler(loaderHandler);
