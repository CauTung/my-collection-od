/** Error policy shared by Shopify native-schema setup mutations. */

export interface SchemaSetupUserError {
  field: string[] | null;
  message: string;
  code?: string;
}

/**
 * Classify an idempotent schema mutation or throw on any unexpected user error.
 *
 * @param operation - Human-readable operation name for the thrown error.
 * @param userErrors - Shopify mutation userErrors.
 * @returns Whether the definition was created or already existed.
 * @throws Error when at least one error is not an already-existing collision.
 */
export function assertSchemaMutationSucceeded(
  operation: string,
  userErrors: SchemaSetupUserError[] | undefined,
  createdDefinition: object | null | undefined
): "created" | "already_exists" {
  if (!Array.isArray(userErrors)) {
    throw new Error(`${operation} failed: missing mutation payload or userErrors`);
  }
  if (userErrors.length === 0) {
    if (!createdDefinition) throw new Error(`${operation} failed: missing created definition`);
    return "created";
  }

  const alreadyExists = userErrors.every((error) => {
    const message = error.message.toLowerCase();
    return error.code === "TAKEN" || message.includes("taken") || message.includes("already exists");
  });
  if (alreadyExists) return "already_exists";

  throw new Error(`${operation} failed: ${JSON.stringify(userErrors)}`);
}
