/** Route-level lifecycle coverage for permanent customer privacy erasure. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.webhooks.customers-redact";
import { authenticateWebhookRequest } from "~/lib/webhook.server";
import {
  hardDeleteMetaobjectForPrivacy,
  listCollectionMetaobjectsForPrivacyDeletion,
} from "~/lib/metaobject.server";
import { listDedupLocksForPrivacyDeletion } from "~/lib/dedup.server";

vi.mock("~/lib/webhook.server", () => ({ authenticateWebhookRequest: vi.fn() }));
vi.mock("~/lib/metaobject.server", () => ({
  hardDeleteMetaobjectForPrivacy: vi.fn(),
  listCollectionMetaobjectsForPrivacyDeletion: vi.fn(),
}));
vi.mock("~/lib/dedup.server", () => ({ listDedupLocksForPrivacyDeletion: vi.fn() }));

const mockAuthenticate = vi.mocked(authenticateWebhookRequest);
const mockListItems = vi.mocked(listCollectionMetaobjectsForPrivacyDeletion);
const mockListLocks = vi.mocked(listDedupLocksForPrivacyDeletion);
const mockHardDelete = vi.mocked(hardDeleteMetaobjectForPrivacy);
const CUSTOMER_ID = "gid://shopify/Customer/123";

function invoke(): Promise<Response> {
  return action({
    request: new Request("https://app.example.com/api/webhooks/customers-redact", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ customer: { id: 123 } });
  mockHardDelete.mockResolvedValue(undefined);
});

describe("customers/redact webhook lifecycle", () => {
  it("re-reads pages and permanently deletes collection items and dedup locks", async () => {
    mockListItems
      .mockResolvedValueOnce([{ id: "item-1", itemId: "one" }])
      .mockResolvedValueOnce([]);
    mockListLocks
      .mockResolvedValueOnce(["lock-1"])
      .mockResolvedValueOnce([]);

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(mockListItems).toHaveBeenCalledTimes(2);
    expect(mockListLocks).toHaveBeenCalledTimes(2);
    expect(mockHardDelete.mock.calls).toEqual([
      [CUSTOMER_ID, "item-1"],
      [CUSTOMER_ID, "lock-1"],
    ]);
  });

  it("returns 500 and stops before dedup deletion when an item deletion fails", async () => {
    mockListItems.mockResolvedValueOnce([{ id: "item-1", itemId: "one" }]);
    mockHardDelete.mockRejectedValueOnce(new Error("temporary delete failure"));

    const response = await invoke();

    expect(response.status).toBe(500);
    expect(mockHardDelete).toHaveBeenCalledTimes(1);
    expect(mockListLocks).not.toHaveBeenCalled();
  });
});
