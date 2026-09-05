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
import { getCollectionItem } from "~/lib/metaobject.server";
import { withErrorHandler, AppError } from "~/lib/error-handler.server";
import { ErrorCode } from "~/types";
import { logger } from "~/lib/logger.server";

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
    try {
      await wishlistAdapter.addToWishlist(session.customer_id, productId);
      return new Response(JSON.stringify({ success: true, message: "Added to wishlist" }), { 
        status: 200, headers: { "Content-Type": "application/json" } 
      });
    } catch (error) {
      logger.error("Wishlist integration failed on add", { error: String(error) });
      return new Response(JSON.stringify({ success: false, message: "Wishlist integration failed" }), { 
        status: 500, headers: { "Content-Type": "application/json" } 
      });
    }
  }

  if (request.method === "DELETE") {
    try {
      await wishlistAdapter.removeFromWishlist(session.customer_id, productId);
      return new Response(JSON.stringify({ success: true, message: "Removed from wishlist" }), { 
        status: 200, headers: { "Content-Type": "application/json" } 
      });
    } catch (error) {
      logger.error("Wishlist integration failed on remove", { error: String(error) });
      return new Response(JSON.stringify({ success: false, message: "Wishlist integration failed" }), { 
        status: 500, headers: { "Content-Type": "application/json" } 
      });
    }
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export const action = withErrorHandler(actionHandler);
