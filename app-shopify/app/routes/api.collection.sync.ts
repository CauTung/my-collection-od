/**
 * app/routes/api.collection.sync.ts
 *
 * POST: Triggers a historical batch sync for the authenticated customer.
 */

import { type ActionFunctionArgs } from "react-router";
import { authenticateAppProxyRequest } from "~/lib/session.server";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { registerBackgroundTask } from "~/lib/background-task.server";

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const session = authenticateAppProxyRequest(request);

  const scheduled = await triggerBatchSync(session.customer_id);
  registerBackgroundTask(scheduled.completion);

  return Response.json({
    success: true,
    status: scheduled.status,
    message: scheduled.status === "queued"
      ? "Sync queued and will start when capacity is available"
      : "Sync process triggered successfully",
  }, { status: 202 });
}

export const action = withErrorHandler(actionHandler);
