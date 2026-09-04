/**
 * app/lib/integrations/yotpo.server.ts
 *
 * Mock Service layer for Yotpo Loyalty API integration.
 * Awards points to collectors when they add items to their collection.
 */

import { logger } from "~/lib/logger.server";
import { LOYALTY_SIGNUP_BONUS_POINTS } from "~/config/constants";

/**
 * Awards loyalty points to a customer.
 * In a real implementation, this would call Yotpo's REST API.
 * This function should NOT throw errors that crash the main flow.
 * 
 * @param customerId - The Shopify Customer GID
 * @param action - The action type (e.g., 'first_item_added')
 * @returns boolean - True if successful, false otherwise.
 */
export async function awardLoyaltyPoints(
  customerId: string, 
  action: "first_item_added" = "first_item_added"
): Promise<boolean> {
  try {
    // 1. Check if the customer already received this reward
    // For MVP, we assume we check some metafield or external state.
    
    // 2. Make REST API call to Yotpo
    // Mocking the delay and response
    await new Promise((resolve) => setTimeout(resolve, 200));

    logger.info("Mock Yotpo API: Awarded points to customer", {
      customerId,
      action,
      points: LOYALTY_SIGNUP_BONUS_POINTS
    });

    return true;
  } catch (error) {
    // We catch locally because loyalty integrations should be non-blocking.
    // If Yotpo is down, the user still gets their collection item synced.
    logger.error("Failed to award Yotpo loyalty points", { 
      customerId, 
      error: String(error) 
    });
    return false;
  }
}
