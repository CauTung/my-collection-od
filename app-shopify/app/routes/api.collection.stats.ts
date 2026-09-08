/**
 * app/routes/api.collection.stats.ts
 *
 * GET: Fetches the cached stats and sync status for the authenticated customer.
 */

import { type LoaderFunctionArgs } from "react-router";
import { authenticateAppProxyRequest } from "~/lib/session.server";
import { getCustomerCollectionMetafields } from "~/lib/metafield.server";
import { withErrorHandler } from "~/lib/error-handler.server";

async function loaderHandler({ request }: LoaderFunctionArgs) {
  const session = authenticateAppProxyRequest(request);

  const { stats, syncState } = await getCustomerCollectionMetafields(session.customer_id);
  return Response.json({ success: true, data: { stats, syncState } });
}

export const loader = withErrorHandler(loaderHandler);
