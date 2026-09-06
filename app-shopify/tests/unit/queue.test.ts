/** Full FIFO lifecycle tests for the instance-local batch job scheduler. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveJobCount,
  getPendingJobCount,
  resetJobQueue,
  scheduleJob,
} from "~/lib/queue.server";
import { MAX_CONCURRENT_BATCH_SYNC_JOBS } from "~/config/constants";

afterEach(() => {
  resetJobQueue();
});

describe("scheduleJob", () => {
  it("runs queued jobs after capacity releases and records a complete lifecycle", async () => {
    let releaseRunningJobs: (() => void) | undefined;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunningJobs = resolve;
    });
    let lifecycleClock = 0;
    const records = Array.from(
      { length: MAX_CONCURRENT_BATCH_SYNC_JOBS + 2 },
      (_, index) => ({ index, dispatchedAt: ++lifecycleClock, startedAt: 0, completedAt: 0 })
    );

    const scheduled = await Promise.all(records.map((record) => scheduleJob(
      `customer-${record.index}`,
      () => Promise.resolve(),
      async () => {
        record.startedAt = ++lifecycleClock;
        if (record.index < MAX_CONCURRENT_BATCH_SYNC_JOBS) await runningGate;
        record.completedAt = ++lifecycleClock;
      }
    )));

    expect(scheduled.filter((job) => job.status === "syncing")).toHaveLength(
      MAX_CONCURRENT_BATCH_SYNC_JOBS
    );
    expect(scheduled.filter((job) => job.status === "queued")).toHaveLength(2);
    expect(getActiveJobCount()).toBe(MAX_CONCURRENT_BATCH_SYNC_JOBS);
    expect(getPendingJobCount()).toBe(2);
    expect(records.at(-1)?.startedAt).toBe(0);

    releaseRunningJobs?.();
    await Promise.all(scheduled.map((job) => job.completion));

    expect(getActiveJobCount()).toBe(0);
    expect(getPendingJobCount()).toBe(0);
    for (const record of records) {
      expect(record.startedAt).toBeGreaterThan(record.dispatchedAt);
      expect(record.completedAt).toBeGreaterThan(record.startedAt);
    }
    expect(records[MAX_CONCURRENT_BATCH_SYNC_JOBS].startedAt).toBeLessThan(
      records[MAX_CONCURRENT_BATCH_SYNC_JOBS + 1].startedAt
    );
  });

  it("coalesces duplicate customer requests onto one running lifecycle", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);

    const first = await scheduleJob("customer-1", () => Promise.resolve(), run);
    const duplicate = await scheduleJob("customer-1", () => Promise.resolve(), run);

    expect(first.isNew).toBe(true);
    expect(duplicate.isNew).toBe(false);
    expect(duplicate.completion).toBe(first.completion);
    expect(run).toHaveBeenCalledTimes(1);

    release?.();
    await first.completion;
  });

  it("preserves dispatch FIFO when a later queued-state write finishes first", async () => {
    let releaseActive: (() => void) | undefined;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeJobs = await Promise.all(Array.from(
      { length: MAX_CONCURRENT_BATCH_SYNC_JOBS },
      (_, index) => scheduleJob(`active-${index}`, () => Promise.resolve(), () => activeGate)
    ));

    let releaseFirstQueuedState: (() => void) | undefined;
    const firstQueuedStateGate = new Promise<void>((resolve) => {
      releaseFirstQueuedState = resolve;
    });
    const startOrder: string[] = [];
    const firstQueuedPromise = scheduleJob(
      "queued-first",
      () => firstQueuedStateGate,
      () => {
        startOrder.push("queued-first");
        return Promise.resolve();
      }
    );
    const secondQueued = await scheduleJob(
      "queued-second",
      () => Promise.resolve(),
      () => {
        startOrder.push("queued-second");
        return Promise.resolve();
      }
    );

    releaseActive?.();
    await Promise.all(activeJobs.map((job) => job.completion));
    expect(startOrder).toEqual([]);

    releaseFirstQueuedState?.();
    const firstQueued = await firstQueuedPromise;
    await Promise.all([firstQueued.completion, secondQueued.completion]);

    expect(startOrder).toEqual(["queued-first", "queued-second"]);
  });

  it("makes duplicate requests share a queued admission failure", async () => {
    let releaseActive: (() => void) | undefined;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeJobs = await Promise.all(Array.from(
      { length: MAX_CONCURRENT_BATCH_SYNC_JOBS },
      (_, index) => scheduleJob(`active-failure-${index}`, () => Promise.resolve(), () => activeGate)
    ));
    let rejectAdmission: ((error: Error) => void) | undefined;
    const admission = new Promise<void>((_resolve, reject) => {
      rejectAdmission = reject;
    });

    const original = scheduleJob("queued-failure", () => admission, () => Promise.resolve());
    const duplicate = scheduleJob("queued-failure", () => Promise.resolve(), () => Promise.resolve());
    rejectAdmission?.(new Error("queued state write failed"));

    await expect(original).rejects.toThrow("queued state write failed");
    await expect(duplicate).rejects.toThrow("queued state write failed");
    expect(getPendingJobCount()).toBe(0);

    releaseActive?.();
    await Promise.all(activeJobs.map((job) => job.completion));
  });
});
