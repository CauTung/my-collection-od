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

  try {
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
  } catch (err) {
    return new Response(JSON.stringify({
      success: true,
      data: {
        stats: { total_items: 0, total_value: 0, wishlisted_count: 0 },
        syncState: { status: "IDLE", last_synced_at: null, total_orders_synced: 0 },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export const loader = withErrorHandler(loaderHandler);
