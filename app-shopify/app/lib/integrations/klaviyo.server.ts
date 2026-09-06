/**
 * app/lib/integrations/klaviyo.server.ts
 *
 * Mock Service layer for Klaviyo API integration.
 * Syncs customer collection stats to Klaviyo segments/profiles.
 */

import { KLAVIYO_MOCK_DELAY_MS } from "~/config/constants";
import { logger } from "~/lib/logger.server";

export interface KlaviyoCustomerProfile {
  totalCollectionItems: number;
  totalCollectionValue: number;
}

/**
 * Updates a customer's profile in Klaviyo with their collection stats.
 * This function should NOT throw errors that crash the main flow.
 * 
 * @param customerId - The Shopify Customer GID
 * @param profile - The updated profile stats
 * @returns boolean - True if successful, false otherwise.
 */
export async function syncCustomerToKlaviyo(
  customerId: string, 
  profile: KlaviyoCustomerProfile
): Promise<boolean> {
  try {
    // Make REST API call to Klaviyo
    // Mocking the delay and response
    await new Promise((resolve) => setTimeout(resolve, KLAVIYO_MOCK_DELAY_MS));

    logger.info("Mock Klaviyo API: Synced customer profile", {
      customerId,
      stats: profile
    });

    return true;
  } catch (error) {
    // Catch locally because integrations should be non-blocking.
    logger.error("Failed to sync customer profile to Klaviyo", { 
      customerId, 
      error: String(error) 
    });
    return false;
  }
}
