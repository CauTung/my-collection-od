/**
 * app/routes/api.collection.$item_id.ts
 *
 * PUT: Updates an existing collection item. Uses idempotency key.
 * DELETE: Soft deletes a collection item.
 */

import { type ActionFunctionArgs } from "react-router";
import { extractAppProxySession } from "~/lib/session.server";
import { updateCollectionItem, deleteCollectionItem } from "~/lib/metaobject.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import { checkAndClaimIdempotencyKey, setIdempotentResult } from "~/lib/idempotency.server";
import { withErrorHandler, AppError } from "~/lib/error-handler.server";
import { ErrorCode } from "~/types";
import { UpdateItemSchema } from "~/lib/validation/schemas";
import { logger } from "~/lib/logger.server";

async function actionHandler({ request, params }: ActionFunctionArgs) {
  const session = extractAppProxySession(request);
  const itemId = params.item_id;

  if (!itemId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing item_id parameter");
  }

  if (request.method === "PUT") {
    const body = await request.json();
    const validationResult = UpdateItemSchema.safeParse(body);
    
    if (!validationResult.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid input data", { 
        issues: validationResult.error.format() 
      });
    }

    const data = validationResult.data;
    const idempotencyKey = data.idempotency_key;

    if (!idempotencyKey) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing idempotency_key");
    }

    // Idempotency Check (Defense against double-submit)
    const claimStatus = checkAndClaimIdempotencyKey(idempotencyKey);
    if (claimStatus.status === "processing") {
      return new Response("Conflict: Request already processing", { status: 409 });
    } else if (claimStatus.status === "finished") {
      logger.info("Idempotency key hit on manual item update", { idempotencyKey, customerId: session.customer_id });
      return new Response(JSON.stringify(claimStatus.result), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Extract exactly what we want to update, excluding idempotency_key
    const updates = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "idempotency_key"));

    await updateCollectionItem(session.customer_id, itemId, updates);

    // Background stats update
    try {
      await recalculateAndCacheStats(session.customer_id);
    } catch (error) {
      logger.error("Failed to update stats after manual item update", { error: String(error) });
    }

    const responseBody = { success: true, message: "Item updated successfully" };
    setIdempotentResult(idempotencyKey, responseBody);

    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (request.method === "DELETE") {
    // Soft delete doesn't strictly need an idempotency key as DELETE is naturally idempotent
    await deleteCollectionItem(session.customer_id, itemId);

    // Background stats update
    try {
      await recalculateAndCacheStats(session.customer_id);
    } catch (error) {
      logger.error("Failed to update stats after item delete", { error: String(error) });
    }

    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const action = withErrorHandler(actionHandler);
