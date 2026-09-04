/**
 * app/routes/api.collection.sync.ts
 *
 * POST: Triggers a historical batch sync for the authenticated customer.
 */

import { type ActionFunctionArgs } from "react-router";
import { extractAppProxySession } from "~/lib/session.server";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { withErrorHandler } from "~/lib/error-handler.server";

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const session = extractAppProxySession(request);

  // triggerBatchSync handles setting the status to 'queued' or 'syncing'
  // and spawning the background process without blocking the HTTP response.
  await triggerBatchSync(session.customer_id);

  return new Response(JSON.stringify({ 
    success: true, 
    message: "Sync process triggered successfully" 
  }), { 
    status: 202, 
    headers: { "Content-Type": "application/json" } 
  }); 
}

export const action = withErrorHandler(actionHandler);
