/**
 * Instance-local FIFO scheduler for historical sync jobs.
 *
 * The scheduler enforces the cross-customer concurrency cap, retains queued callbacks,
 * starts them when a running job settles, and exposes one completion promise covering
 * the full queued-to-terminal lifecycle. Vercel instances do not share this state.
 */

import { MAX_CONCURRENT_BATCH_SYNC_JOBS } from "~/config/constants";
import { logger } from "./logger.server";

export type ScheduledJobStatus = "syncing" | "queued";

export interface ScheduledJob {
  status: ScheduledJobStatus;
  completion: Promise<void>;
  isNew: boolean;
}

interface QueueEntry {
  key: string;
  run: () => Promise<void>;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  status: ScheduledJobStatus;
  ready: boolean;
  admission: Promise<void>;
}

const jobsByKey = new Map<string, QueueEntry>();
const pendingJobs: QueueEntry[] = [];
let activeJobs = 0;

/**
 * Schedule one uniquely keyed job and return its complete lifecycle promise.
 *
 * @param key - Stable instance-local identity, normally the authenticated customer GID.
 * @param markQueued - Persists queued state before the entry becomes eligible to start.
 * @param run - Complete job lifecycle, including syncing and terminal state updates.
 * @returns Initial state, completion promise, and whether a new entry was created.
 * @throws The queued-state error when it cannot be persisted.
 */
export async function scheduleJob(
  key: string,
  markQueued: () => Promise<void>,
  run: () => Promise<void>
): Promise<ScheduledJob> {
  const existing = jobsByKey.get(key);
  if (existing) {
    await existing.admission;
    return { status: existing.status, completion: existing.completion, isNew: false };
  }

  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const entry: QueueEntry = {
    key,
    run,
    completion,
    resolve: () => resolveCompletion?.(),
    reject: (error) => rejectCompletion?.(error),
    status: activeJobs < MAX_CONCURRENT_BATCH_SYNC_JOBS ? "syncing" : "queued",
    ready: true,
    admission: Promise.resolve(),
  };
  jobsByKey.set(key, entry);

  if (entry.status === "syncing") {
    startEntry(entry);
  } else {
    entry.ready = false;
    pendingJobs.push(entry);
    entry.admission = Promise.resolve().then(markQueued);
    try {
      await entry.admission;
    } catch (error) {
      jobsByKey.delete(key);
      const pendingIndex = pendingJobs.indexOf(entry);
      if (pendingIndex >= 0) pendingJobs.splice(pendingIndex, 1);
      entry.reject(error);
      void entry.completion.catch(() => undefined);
      drainQueue();
      throw error;
    }
    entry.ready = true;
    logger.warn("Batch sync job queued on this instance", {
      activeJobs,
      queuedJobs: pendingJobs.length,
      limit: MAX_CONCURRENT_BATCH_SYNC_JOBS,
    });
    drainQueue();
  }

  return { status: entry.status, completion, isNew: true };
}

/** Return the current active job count for monitoring and tests. */
export function getActiveJobCount(): number {
  return activeJobs;
}

/** Return the current pending FIFO depth for monitoring and tests. */
export function getPendingJobCount(): number {
  return pendingJobs.length;
}

/** Reset scheduler state. Tests must call this only after all scheduled jobs settle. */
export function resetJobQueue(): void {
  activeJobs = 0;
  pendingJobs.length = 0;
  jobsByKey.clear();
}

function startEntry(entry: QueueEntry): void {
  entry.status = "syncing";
  activeJobs += 1;
  logger.info("Batch sync job started on this instance", {
    activeJobs,
    queuedJobs: pendingJobs.length,
    limit: MAX_CONCURRENT_BATCH_SYNC_JOBS,
  });

  void Promise.resolve()
    .then(entry.run)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      activeJobs -= 1;
      jobsByKey.delete(entry.key);
      logger.info("Batch sync job slot released", {
        activeJobs,
        queuedJobs: pendingJobs.length,
        limit: MAX_CONCURRENT_BATCH_SYNC_JOBS,
      });
      drainQueue();
    });
}

function drainQueue(): void {
  while (activeJobs < MAX_CONCURRENT_BATCH_SYNC_JOBS && pendingJobs.length > 0) {
    if (!pendingJobs[0]?.ready) return;
    const next = pendingJobs.shift();
    if (next) startEntry(next);
  }
}
