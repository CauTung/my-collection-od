/**
 * app/lib/validation/schemas.ts
 *
 * Zod validation schemas for all incoming request bodies.
 *
 * Design decisions:
 * - All request body validation goes through Zod. No manual if/else checks in routes.
 * - Max lengths mirror constants.ts exactly — import from there, never hardcode.
 * - user_notes, user_grade, certificate_number accept any string content; sanitization
 *   happens at the GraphQL layer (always via variables, never string-interpolated).
 *   (Prevents GraphQL injection).
 */

import { z } from "zod";
import {
  MAX_QUANTITY_OWNED,
  MAX_CERTIFICATE_NUMBER_LENGTH,
  MAX_USER_GRADE_LENGTH,
  MAX_USER_NOTES_LENGTH,
} from "~/config/constants";

// ─── Shared Field Schemas ────────────────────────────────────────────────────

const shopifyGidSchema = z
  .string()
  .startsWith("gid://shopify/", "Must be a Shopify GID (gid://shopify/...)");

const quantitySchema = z
  .number()
  .int("Must be an integer")
  .min(1, "Minimum quantity is 1")
  .max(MAX_QUANTITY_OWNED, `Maximum quantity is ${MAX_QUANTITY_OWNED}`);

const decimalSchema = z.number().nonnegative("Must be a non-negative number");

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
  .optional();

const idempotencyKeySchema = z
  .string()
  .uuid("idempotency_key must be a valid UUID v4");

// ─── Add Item (POST /api/collection) ────────────────────────────────────────

export const AddItemSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  product_id: shopifyGidSchema,
  sku_code: z.string().optional(),
  quantity_owned: quantitySchema.default(1),
  purchase_date: dateStringSchema,
  purchase_price: decimalSchema.optional(),
  current_market_value: decimalSchema.optional(),
  certificate_number: z
    .string()
    .max(MAX_CERTIFICATE_NUMBER_LENGTH, `Max ${MAX_CERTIFICATE_NUMBER_LENGTH} characters`)
    .optional(),
  user_grade: z
    .string()
    .max(MAX_USER_GRADE_LENGTH, `Max ${MAX_USER_GRADE_LENGTH} characters`)
    .optional(),
  user_notes: z
    .string()
    .max(MAX_USER_NOTES_LENGTH, `Max ${MAX_USER_NOTES_LENGTH} characters`)
    .optional(),
  in_wishlist: z.boolean().default(false),
});

export type AddItemInput = z.infer<typeof AddItemSchema>;

// ─── Update Item (PUT /api/collection/:item_id) ──────────────────────────────

export const UpdateItemSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  quantity_owned: quantitySchema.optional(),
  purchase_date: dateStringSchema,
  purchase_price: decimalSchema.optional(),
  current_market_value: decimalSchema.optional(),
  certificate_number: z
    .string()
    .max(MAX_CERTIFICATE_NUMBER_LENGTH)
    .optional(),
  user_grade: z.string().max(MAX_USER_GRADE_LENGTH).optional(),
  user_notes: z.string().max(MAX_USER_NOTES_LENGTH).optional(),
  in_wishlist: z.boolean().optional(),
});

export type UpdateItemInput = z.infer<typeof UpdateItemSchema>;

// ─── Trigger Sync (POST /api/collection/sync) ───────────────────────────────

export const TriggerSyncSchema = z.object({
  // No required fields — trigger is initiated by authenticated customer session alone
  force: z.boolean().default(false), // force re-sync even if recently synced
});

export type TriggerSyncInput = z.infer<typeof TriggerSyncSchema>;

// ─── Collection List Filters (GET /api/collection query params) ──────────────

export const CollectionFiltersSchema = z.object({
  denomination: z.string().optional(),
  country_of_issue: z.string().optional(),
  material: z.string().optional(),
  year_of_issue: z.string().optional(),
  grade: z.string().optional(),
  issuer: z.string().optional(),
  in_wishlist: z
    .string()
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined)),
  after: z.string().optional(),
  first: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined)),
});
