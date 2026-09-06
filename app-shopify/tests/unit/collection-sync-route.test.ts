/** HTTP contract tests for historical sync scheduling. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.collection.sync";
import { authenticateAppProxyRequest } from "~/lib/session.server";
import { triggerBatchSync } from "~/lib/batch-sync.server";
import { registerBackgroundTask } from "~/lib/background-task.server";

vi.mock("~/lib/session.server", () => ({ authenticateAppProxyRequest: vi.fn() }));
vi.mock("~/lib/batch-sync.server", () => ({ triggerBatchSync: vi.fn() }));
vi.mock("~/lib/background-task.server", () => ({ registerBackgroundTask: vi.fn() }));

const mockAuthenticate = vi.mocked(authenticateAppProxyRequest);
const mockTrigger = vi.mocked(triggerBatchSync);
const mockRegister = vi.mocked(registerBackgroundTask);

function invoke(): Promise<Response> {
  return action({
    request: new Request("https://app.example.com/api/collection/sync", { method: "POST" }),
  } as Parameters<typeof action>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockReturnValue({
    customer_id: "gid://shopify/Customer/123",
    shop: "test-shop.myshopify.com",
    path_prefix: "/apps/my-collection",
  });
});

describe("POST /api/collection/sync", () => {
  it("returns and registers the exact queued completion lifecycle", async () => {
    const completion = Promise.resolve();
    mockTrigger.mockResolvedValue({ status: "queued", completion, isNew: true });

    const response = await invoke();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      status: "queued",
      message: "Sync queued and will start when capacity is available",
    });
    expect(mockRegister).toHaveBeenCalledExactlyOnceWith(completion);
  });

  it("returns 500 instead of disguising a scheduler failure as HTTP 200", async () => {
    mockTrigger.mockRejectedValueOnce(new Error("queue state write failed"));

    const response = await invoke();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "INTERNAL_ERROR" });
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
