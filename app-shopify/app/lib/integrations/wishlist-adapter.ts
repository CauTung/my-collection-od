/**
 * app/lib/integrations/wishlist-adapter.ts
 *
 * Interface Adapter Pattern for Wishlist functionality.
 * Since the Wishlist vendor is not yet chosen, we use a NullWishlistAdapter
 * to prevent breaking the system while allowing the UI to integrate cleanly.
 */

import { logger } from "~/lib/logger.server";
import type { WishlistAdapter } from "~/types";

/**
 * A no-op implementation of the WishlistAdapter.
 * Used as a placeholder until the final vendor (e.g., Swym, Growave) is selected.
 */
export class NullWishlistAdapter implements WishlistAdapter {
  async addToWishlist(customerId: string, productId: string): Promise<void> {
    logger.debug("NullWishlistAdapter: Add to wishlist", { customerId, productId });
  }

  async removeFromWishlist(customerId: string, productId: string): Promise<void> {
    logger.debug("NullWishlistAdapter: Remove from wishlist", { customerId, productId });
  }

  async isInWishlist(_customerId: string, _productId: string): Promise<boolean> {
    // Default to false since we don't have real data
    return false;
  }
}

// Singleton instance to be used across the app
export const wishlistAdapter: WishlistAdapter = new NullWishlistAdapter();
