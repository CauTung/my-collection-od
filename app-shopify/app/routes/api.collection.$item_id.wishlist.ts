/**
 * app/routes/api.collection.$item_id.wishlist.ts
 *
 * POST: Adds an item to the wishlist
 * DELETE: Removes an item from the wishlist
 *
 * This interacts with the WishlistAdapter (e.g. Swym, Growave, Null)
 */

import { type ActionFunctionArgs } from "react-router";
import { authenticateAppProxyRequest } from "~/lib/session.server";
import { wishlistAdapter } from "~/lib/integrations/wishlist-adapter";
import { getCollectionItem, updateCollectionItem } from "~/lib/metaobject.server";
import { withErrorHandler, AppError } from "~/lib/error-handler.server";
import { ErrorCode } from "~/types";

async function actionHandler({ request, params }: ActionFunctionArgs) {
  const session = authenticateAppProxyRequest(request);
  const itemId = params.item_id;

  if (!itemId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Missing item_id parameter");
  }

  // Verify the item exists and belongs to the customer
  const item = await getCollectionItem(session.customer_id, itemId);
  if (!item) {
    throw new AppError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
  }
  
  const productId = item.product_id;

  if (request.method === "POST") {
    await wishlistAdapter.addToWishlist(session.customer_id, productId);
    const updatedItem = await updateCollectionItem(session.customer_id, itemId, {
      in_wishlist: true,
    });
    return Response.json({
      success: true,
      message: "Added to wishlist",
      data: updatedItem,
    });
  }

  if (request.method === "DELETE") {
    await wishlistAdapter.removeFromWishlist(session.customer_id, productId);
    const updatedItem = await updateCollectionItem(session.customer_id, itemId, {
      in_wishlist: false,
    });
    return Response.json({
      success: true,
      message: "Removed from wishlist",
      data: updatedItem,
    });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const action = withErrorHandler(actionHandler);
