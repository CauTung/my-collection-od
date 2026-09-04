/**
 * app/lib/error-handler.server.ts
 *
 * Centralized error handling for all Remix route actions and loaders.
 *
 * Design decisions:
 * - AppError is a typed business error with a known ErrorCode. Routes throw AppError for
 *   predictable failures (HMAC invalid, item not found, etc.) and withErrorHandler converts
 *   them to clean JSON responses with the correct HTTP status.
 * - Unknown infrastructure errors (network, parse failures) are caught by withErrorHandler
 *   and returned as generic 500 responses — never swallowed silently.
 * - Every route action/loader MUST be wrapped with withErrorHandler. No loose try/catch
 *   in route files — business logic lives in lib/, routes are thin HTTP adapters.
 */

import { ErrorCode } from "~/types";
import { logger } from "./logger.server";

/** Maps ErrorCode to HTTP status. Keeps HTTP concerns out of business logic. */
const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.HMAC_INVALID]: 401,
  [ErrorCode.CUSTOMER_NOT_AUTHENTICATED]: 401,
  [ErrorCode.ITEM_NOT_FOUND]: 404,
  [ErrorCode.ITEM_ACCESS_DENIED]: 403,
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 200, // Return 200 with cached result, not an error
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.SYNC_ALREADY_RUNNING]: 409,
  [ErrorCode.SYNC_QUEUED]: 202,
  [ErrorCode.GRAPHQL_ERROR]: 502,
};

/**
 * Typed business error. Throw this for predictable, named failure modes.
 * Infrastructure errors (network, parse) should be allowed to propagate naturally.
 *
 * @throws Never — this IS the thing being thrown.
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Wraps a route action/loader handler with standardized error handling.
 *
 * Usage in route files:
 *   export const action = withErrorHandler(async ({ request }) => { ... });
 *
 * @param handler - The async route handler function.
 * @returns A new function that catches AppError and unknown errors, returning JSON responses.
 */
export function withErrorHandler<TArgs>(
  handler: (args: TArgs) => Promise<Response>
): (args: TArgs) => Promise<Response> {
  return async (args: TArgs): Promise<Response> => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof AppError) {
        const status = ERROR_HTTP_STATUS[err.code];
        logger.warn("Business error handled by withErrorHandler", {
          code: err.code,
          message: err.message,
          status,
        });
        return Response.json(
          { error: err.code, message: err.message, details: err.details },
          { status }
        );
      }

      // Unknown infrastructure error — log with full context, return generic 500
      logger.error("Unhandled infrastructure error in route handler", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      return Response.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        { status: 500 }
      );
    }
  };
}
