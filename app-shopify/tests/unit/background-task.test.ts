/** Hosting-lifecycle tests for registered background work. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitUntil } from "@vercel/functions";
import { registerBackgroundTask } from "~/lib/background-task.server";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const mockWaitUntil = vi.mocked(waitUntil);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("registerBackgroundTask", () => {
  it("attaches the observed task to the Vercel invocation", () => {
    vi.stubEnv("VERCEL", "1");
    const task = Promise.resolve();

    registerBackgroundTask(task);

    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    expect(mockWaitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it("does not call Vercel runtime APIs during local execution", () => {
    vi.stubEnv("VERCEL", "");

    registerBackgroundTask(Promise.resolve());

    expect(mockWaitUntil).not.toHaveBeenCalled();
  });
});
