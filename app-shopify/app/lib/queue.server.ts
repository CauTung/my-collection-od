/**
 * app/lib/queue.server.ts
 *
 * System-wide concurrent batch sync job limiter.
 *
 * Design decisions:
 * - BATCH_SYNC_CONCURRENCY (in batch-sync.server.ts) only limits parallelism within
 *   ONE customer's job. It does NOT prevent multiple customers from running sync jobs
 *   simultaneously, which could overload the shop's shared Shopify Leaky Bucket.
 *   (Cross-customer throttling).
 * - This module maintains a simple in-memory counter capped at MAX_CONCURRENT_BATCH_SYNC_JOBS.
 *   Jobs beyond the cap receive status "queued" and must be retried by the client.
 * - Trade-off: in serverless with multiple instances, each instance has its own counter.
 *   The total across instances could exceed the limit. This is an accepted trade-off
 *   using an in-memory counter. If cross-instance throttling becomes needed in
 *   production, a distributed lock (Redis/Shopify Metaobject) could be used.
 */

import { MAX_CONCURRENT_BATCH_SYNC_JOBS } from "~/config/constants";
import { logger } from "./logger.server";

// In-memory job counter — capped at MAX_CONCURRENT_BATCH_SYNC_JOBS per instance
let activeJobs = 0;

/**
 * Attempt to start a new batch sync job.
 * Returns true if the job can proceed, false if the system is at capacity.
 *
 * @returns true if a slot was acquired (caller MUST release via releaseJobSlot).
 */
export function acquireJobSlot(): boolean {
  if (activeJobs >= MAX_CONCURRENT_BATCH_SYNC_JOBS) {
    logger.warn("System at max concurrent batch sync capacity — job queued", {
      activeJobs,
      limit: MAX_CONCURRENT_BATCH_SYNC_JOBS,
    });
    return false;
  }
  activeJobs++;
  logger.info("Batch sync job slot acquired", {
    activeJobs,
    limit: MAX_CONCURRENT_BATCH_SYNC_JOBS,
  });
  return true;
}

/**
 * Release a job slot after the batch sync job completes (success or failure).
 * MUST be called in a finally block to prevent slot leaks.
 */
export function releaseJobSlot(): void {
  if (activeJobs > 0) {
    activeJobs--;
  }
  logger.info("Batch sync job slot released", {
    activeJobs,
    limit: MAX_CONCURRENT_BATCH_SYNC_JOBS,
  });
}

/** Return the current active job count — for monitoring and testing. */
export function getActiveJobCount(): number {
  return activeJobs;
}

/**
 * Reset the counter to zero. ONLY for use in tests.
 * Must NOT be called in production code.
 */
export function resetJobCounter(): void {
  activeJobs = 0;
}
