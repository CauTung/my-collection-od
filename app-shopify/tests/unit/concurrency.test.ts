/** Exact concurrency coverage for bounded asynchronous chunk processing. */

import { describe, expect, it, vi } from "vitest";
import { mapSettledInChunks } from "~/lib/concurrency.server";

describe("mapSettledInChunks", () => {
  it("runs exactly five operations concurrently and preserves every result", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirstChunk: (() => void) | undefined;
    const firstChunkGate = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });

    const execution = mapSettledInChunks(
      [1, 2, 3, 4, 5, 6, 7],
      5,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (value <= 5) {
          await firstChunkGate;
        }
        active -= 1;
        return value * 2;
      }
    );

    await vi.waitFor(() => expect(maximumActive).toBe(5));
    releaseFirstChunk?.();

    await expect(execution).resolves.toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
      { status: "fulfilled", value: 6 },
      { status: "fulfilled", value: 8 },
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 12 },
      { status: "fulfilled", value: 14 },
    ]);
    expect(maximumActive).toBe(5);
  });

  it("isolates a rejected operation and continues later chunks", async () => {
    const results = await mapSettledInChunks([1, 2, 3], 2, (value) => {
      if (value === 2) return Promise.reject(new Error("expected failure"));
      return Promise.resolve(value);
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
