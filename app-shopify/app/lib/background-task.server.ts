/** Registers post-response work with the active hosting runtime. */

import { waitUntil } from "@vercel/functions";
import { logger } from "./logger.server";

/**
 * Keep one task attached to the Vercel invocation after returning the HTTP response.
 * Local and test runtimes continue the promise in-process without Vercel context.
 */
export function registerBackgroundTask(task: Promise<void>): void {
  const observedTask = task.catch((error: unknown) => {
    logger.error("Background task failed", { error: String(error) });
  });

  if (process.env.VERCEL === "1") {
    waitUntil(observedTask);
    return;
  }

  void observedTask;
}
