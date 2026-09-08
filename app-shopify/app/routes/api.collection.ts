/**
 * app/routes/api.collection.ts
 *
 * GET: Lists collection items for the authenticated customer (with pagination and filters).
 * POST: Manual entry of a new collection item. Uses idempotency to prevent double-submit.
 */

import { type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticateAppProxyRequest } from "~/lib/session.server";
import { listCollectionItems, createCollectionItem } from "~/lib/metaobject.server";
import { recalculateAndCacheStats } from "~/lib/stats.server";
import {
  checkAndClaimIdempotencyKey,
  releaseIdempotencyClaim,
  setIdempotentResult,
} from "~/lib/idempotency.server";
import { withErrorHandler, AppError } from "~/lib/error-handler.server";
import { ErrorCode, type CollectionFilters } from "~/types";
import { AddItemSchema as CollectionItemSchema } from "~/lib/validation/schemas";
import { logger } from "~/lib/logger.server";

async function loaderHandler({ request }: LoaderFunctionArgs) {
  const session = authenticateAppProxyRequest(request);
  const url = new URL(request.url);

  const filters: CollectionFilters = {
    first: url.searchParams.get("first") ? parseInt(url.searchParams.get("first")!, 10) : undefined,
    after: url.searchParams.get("after") || undefined,
    in_wishlist: url.searchParams.has("in_wishlist") ? url.searchParams.get("in_wishlist") === "true" : undefined,
  };

  const result = await listCollectionItems(session.customer_id, filters);
  return Response.json({ success: true, data: result.items, pageInfo: result.pageInfo });
}

export const loader = withErrorHandler(loaderHandler);

async function actionHandler({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const session = authenticateAppProxyRequest(request);
  const body = await request.json();

  // Validate request body
  const validationResult = CollectionItemSchema.safeParse(body);
  if (!validationResult.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid input data", { 
      issues: validationResult.error.format() 
    });
  }

  const data = validationResult.data;
  const idempotencyKey = data.idempotency_key;
  const idempotencyScope = {
    customerId: session.customer_id,
    operation: "create" as const,
  };

  if (!idempotencyKey) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing idempotency_key");
  }

  // Idempotency Check (Defense against double-submit)
  const claimStatus = checkAndClaimIdempotencyKey(idempotencyScope, idempotencyKey);
  if (claimStatus.status === "processing") {
    return new Response("Conflict: Request already processing", { status: 409 });
  } else if (claimStatus.status === "finished") {
    logger.info("Idempotency key hit on manual item creation", { idempotencyKey, customerId: session.customer_id });
    return new Response(JSON.stringify(claimStatus.result), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Create Item
  let newItem: Awaited<ReturnType<typeof createCollectionItem>>;
  try {
    newItem = await createCollectionItem(session.customer_id, {
      ...data,
      source: "manual_entry",
    });
  } catch (error) {
    releaseIdempotencyClaim(idempotencyScope, idempotencyKey);
    throw error;
  }

  // Background stats update
  try {
    await recalculateAndCacheStats(session.customer_id);
  } catch (error) {
    logger.error("Failed to update stats after manual item creation", { error: String(error) });
  }

  const responseBody = { success: true, data: newItem };
  setIdempotentResult(idempotencyScope, idempotencyKey, responseBody);

  return new Response(JSON.stringify(responseBody), { status: 201, headers: { "Content-Type": "application/json" } });
}

export const action = withErrorHandler(actionHandler);
