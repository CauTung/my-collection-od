/**
 * Reads the minimal Shopify order context required by webhook handlers.
 * Refund payloads don't include a dependable customer object, so the order is resolved
 * through Admin GraphQL using the configured store token.
 */

import { shopifyGraphQL } from "./graphql-client.server";
import { AppError } from "./error-handler.server";
import { ErrorCode } from "~/types";

/**
 * Resolve the customer GID attached to an order.
 *
 * @param orderId - Shopify Order GID.
 * @returns Customer GID, or null for a guest/deleted-customer order.
 * @throws AppError(GRAPHQL_ERROR) when Shopify omits the expected order payload.
 */
export async function getOrderCustomerId(orderId: string): Promise<string | null> {
  const result = await shopifyGraphQL<{
    order?: { customer?: { id: string } | null } | null;
  }>(
    `query GetWebhookOrderCustomer($id: ID!) {
      order(id: $id) {
        customer { id }
      }
    }`,
    { id: orderId }
  );

  if (!result.data || !("order" in result.data)) {
    throw new AppError(ErrorCode.GRAPHQL_ERROR, "Shopify did not return the webhook order payload");
  }

  return result.data.order?.customer?.id ?? null;
}
