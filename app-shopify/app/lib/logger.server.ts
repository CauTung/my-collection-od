/**
 * app/lib/logger.server.ts
 *
 * Structured JSON logger for the entire application.
 *
 * Design decisions:
 * - Outputs JSON to stdout so log aggregators (Vercel, AWS CloudWatch) can parse fields.
 * - Auto-redacts known PII fields before logging to avoid leaking customer data to logs.
 * - Log levels: debug < info < warn < error. In production, debug is suppressed.
 * - All server modules import from here — never use console.log directly.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

/** Fields that must never appear in plaintext in logs. Replaced with "[REDACTED]". */
const PII_FIELDS = new Set([
  "email",
  "phone",
  "first_name",
  "last_name",
  "address1",
  "address2",
  "city",
  "zip",
  "province",
  "country",
  "name",
  "customer_email",
  "customer_id",
  "customerid",
  "note",
]);

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const IS_TEST = process.env.NODE_ENV === "test";

/**
 * Recursively redact PII fields from an object before logging.
 * Mutates a deep clone — never mutates the original.
 */
function redactPii(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactPii);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (PII_FIELDS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactPii(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Write a structured log entry to stdout.
 * Suppressed in test environment to keep test output clean.
 */
function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  // Suppress debug in production; suppress all in test unless explicitly enabled
  if (IS_TEST && process.env.ENABLE_TEST_LOGS !== "true") return;
  if (IS_PRODUCTION && level === "debug") return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? { context: redactPii(context) } : {}),
  };

  // Use stderr for errors so they surface separately in log aggregators
  const output = level === "error" ? process.stderr : process.stdout;
  output.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  /** Detailed diagnostic information — suppressed in production. */
  debug: (message: string, context?: Record<string, unknown>) => log("debug", message, context),

  /** Normal application flow — sync completed, cache hit, etc. */
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),

  /**
   * Recoverable anomalies — dedup collision caught (expected), Yotpo call failed (non-blocking).
   * These are NOT errors; they are expected edge cases handled gracefully.
   */
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),

  /** Unexpected failures that require attention. Always surfaces in production. */
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};
