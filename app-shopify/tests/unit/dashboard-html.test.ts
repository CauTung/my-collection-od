import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildDashboardHtml } from "../../app/lib/dashboard-html.server";
import { APP_PROXY_DEFAULT_PATH_PREFIX, COLLECTION_PAGE_SIZE } from "../../app/config/constants";

interface DomEvent { key?: string; shiftKey?: boolean; preventDefault: () => void }
class Element {
  value = "";
  hidden = false;
  disabled = false;
  checked = false;
  textContent = "";
  className = "";
  type = "";
  isConnected = true;
  children: Element[] = [];
  listeners = new Map<string, (event: DomEvent) => void>();
  constructor(private readonly focusElement: (element: Element) => void) {}
  get firstChild() { return this.children[0]; }
  appendChild(element: Element) { this.children.push(element); return element; }
  removeChild(element: Element) { this.children = this.children.filter((child) => child !== element); }
  remove() { this.isConnected = false; }
  setAttribute() { return undefined; }
  focus() { this.focusElement(this); }
  addEventListener(name: string, callback: (event: DomEvent) => void) { this.listeners.set(name, callback); }
  dispatch(name: string, properties: Partial<DomEvent> = {}) {
    const event = { preventDefault: vi.fn(), ...properties };
    this.listeners.get(name)?.(event);
    return event;
  }
}
function harness(prefix = APP_PROXY_DEFAULT_PATH_PREFIX) {
  const elements = new Map<string, Element>();
  const document = {
    activeElement: null as Element | null,
    body: new Element(focus),
    getElementById(id: string) {
      let element = elements.get(id);
      if (!element) { element = new Element(focus); elements.set(id, element); }
      return element;
    },
    createElement() { return new Element(focus); },
  };
  function focus(element: Element) { document.activeElement = element; }
  const timers: (() => void)[] = [];
  const fetch = vi.fn((url: string, _options?: { method?: string; body?: string }) => Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify(url.endsWith("/stats")
      ? { data: { stats: { total_items: 1 }, syncState: { sync_status: "idle" } } }
      : { data: [{ item_id: "one", product_id: "gid://shopify/Product/1", quantity_owned: 1, user_notes: "Original" }], pageInfo: { hasNextPage: true, endCursor: "next" } })),
  }));
  const script = buildDashboardHtml(prefix).match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("Dashboard script is missing");
  runInNewContext(script, { document, fetch, crypto: { randomUUID: () => "test-key" }, setTimeout: (callback: () => void) => timers.push(callback), confirm: () => true });
  return { document, fetch, timers, element: (id: string) => document.getElementById(id), toasts: () => document.body.children.map((child) => child.textContent) };
}
async function flush() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }

describe("dashboard browser behavior", () => {
  it("keeps hidden controls hidden despite dashboard display rules", () => {
    expect(buildDashboardHtml(APP_PROXY_DEFAULT_PATH_PREFIX)).toContain("#dc-app [hidden],.dc-modal[hidden],.dc-modal [hidden] { display:none !important; }");
  });
  it("hides pagination for an empty collection and restores it for a following page", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: [], pageInfo: { hasNextPage: false, endCursor: null } })) });
    browser.element("dc-load-more").dispatch("click");
    await flush();
    expect(browser.element("dc-load-more").hidden).toBe(true);
    browser.element("dc-load-more").dispatch("click");
    expect(browser.fetch).toHaveBeenCalledTimes(3);
  });
  it("disables product validation during edit and restores it for add", async () => {
    const browser = harness();
    await flush();
    browser.element("dc-grid").children[0].children[2].children[1].children[1].dispatch("click");
    expect(browser.element("dc-product-field").hidden).toBe(true);
    expect(browser.element("dc-product-id").disabled).toBe(true);
    browser.element("dc-cancel-item").dispatch("click");
    browser.element("dc-add-btn").dispatch("click");
    expect(browser.element("dc-product-id").disabled).toBe(false);
  });
  it("shows API messages and offers retry after an initial load failure", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve(JSON.stringify({ error: "GRAPHQL_ERROR", message: "Shopify unavailable" })) });
    browser.element("dc-retry").dispatch("click");
    await flush();
    expect(browser.element("dc-retry").hidden).toBe(false);
    expect(browser.element("dc-loading").textContent).toBe("Failed to load collection: Shopify unavailable");
    browser.element("dc-retry").dispatch("click");
    await flush();
    expect(browser.element("dc-retry").hidden).toBe(true);
    expect(browser.element("dc-loading").hidden).toBe(true);
  });
  it("blocks repeated wishlist mutations while the item is busy", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "one",
          product_id: "gid://shopify/Product/1",
          quantity_owned: 1,
          user_notes: "Original",
          in_wishlist: true,
        },
      })),
    });
    const button = browser.element("dc-grid").children[0].children[2].children[1].children[0];
    button.dispatch("click");
    button.dispatch("click");
    expect(browser.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(browser.element("dc-grid").children[0].children[2].children[1].children.map((action) => action.disabled)).toEqual([true, true, true]);
    await flush();
    expect(browser.element("dc-grid").children[0].children[2].children[1].children.map((action) => action.disabled)).toEqual([false, false, false]);
  });
  it("updates wishlist and unwishlist state directly from each mutation response", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "one",
          product_id: "gid://shopify/Product/1",
          quantity_owned: 1,
          user_notes: "Original",
          in_wishlist: true,
        },
      })),
    });
    browser.element("dc-grid").children[0].children[2].children[1].children[0].dispatch("click");
    await flush();

    expect(browser.fetch.mock.calls[2][1]?.method).toBe("POST");
    expect(browser.element("dc-grid").children[0].children[2].children[1].children[0].textContent).toBe("Unwishlist");

    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "one",
          product_id: "gid://shopify/Product/1",
          quantity_owned: 1,
          user_notes: "Original",
          in_wishlist: false,
        },
      })),
    });
    browser.element("dc-grid").children[0].children[2].children[1].children[0].dispatch("click");
    await flush();

    expect(browser.fetch.mock.calls[3][1]?.method).toBe("DELETE");
    expect(browser.element("dc-grid").children[0].children[2].children[1].children[0].textContent).toBe("Wishlist");
    expect(browser.fetch).toHaveBeenCalledTimes(4);
  });
  it("keeps wishlist state unchanged and unlocks controls after a failed mutation", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ message: "Wishlist persistence failed" })),
    });
    browser.element("dc-grid").children[0].children[2].children[1].children[0].dispatch("click");
    await flush();

    const actions = browser.element("dc-grid").children[0].children[2].children[1];
    expect(actions.children[0].textContent).toBe("Wishlist");
    expect(actions.children.map((action) => action.disabled)).toEqual([false, false, false]);
    expect(browser.toasts()).toContain("Wishlist failed: Wishlist persistence failed");
  });
  it("rejects malformed wishlist success responses without changing local state", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    });
    browser.element("dc-grid").children[0].children[2].children[1].children[0].dispatch("click");
    await flush();

    const actions = browser.element("dc-grid").children[0].children[2].children[1];
    expect(actions.children[0].textContent).toBe("Wishlist");
    expect(actions.children.map((action) => action.disabled)).toEqual([false, false, false]);
    expect(browser.toasts()).toContain("Wishlist failed: Wishlist response is missing item data");
  });
  it("keeps unwishlist state unchanged and unlocks controls after a failed removal", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "one",
          product_id: "gid://shopify/Product/1",
          quantity_owned: 1,
          user_notes: "Original",
          in_wishlist: true,
        },
      })),
    });
    browser.element("dc-grid").children[0].children[2].children[1].children[0].dispatch("click");
    await flush();
    browser.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ message: "Wishlist removal failed" })),
    });
    browser.element("dc-grid").children[0].children[2].children[1].children[0].dispatch("click");
    await flush();

    const actions = browser.element("dc-grid").children[0].children[2].children[1];
    expect(browser.fetch.mock.calls[3][1]?.method).toBe("DELETE");
    expect(actions.children[0].textContent).toBe("Unwishlist");
    expect(actions.children.map((action) => action.disabled)).toEqual([false, false, false]);
    expect(browser.toasts()).toContain("Wishlist failed: Wishlist removal failed");
  });
  it("blocks pagination during a replacement refresh after deletion", async () => {
    const browser = harness();
    await flush();
    let finishRefresh: ((response: { ok: boolean; status: number; text: () => Promise<string> }) => void) | undefined;
    // New flow after delete: DELETE request, then loadCollection (pending).
    // loadStats is called via setTimeout so it does not fire in this test.
    browser.fetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    browser.fetch.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    browser.element("dc-grid").children[0].children[2].children[1].children[2].dispatch("click");
    await flush();
    expect(browser.element("dc-load-more").disabled).toBe(true);
    browser.element("dc-load-more").dispatch("click");
    expect(browser.fetch).toHaveBeenCalledTimes(4);
    if (!finishRefresh) throw new Error("Replacement request did not start");
    finishRefresh({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: [], pageInfo: { hasNextPage: false } })) });
    await flush();
    expect(browser.element("dc-load-more").hidden).toBe(true);
    expect(browser.element("dc-grid").children[0].textContent).toBe("No items yet. Sync past orders or add an item manually.");
  });
  it.each(["//external.example", "/\\external.example", "/\n/external.example"])("keeps API requests same-origin for invalid prefix %s", (prefix) => {
    const browser = harness(prefix);
    expect(browser.fetch.mock.calls.map(([url]) => url)).toEqual([`${APP_PROXY_DEFAULT_PATH_PREFIX}/api/collection/stats`, `${APP_PROXY_DEFAULT_PATH_PREFIX}/api/collection?first=${COLLECTION_PAGE_SIZE}`]);
  });
  it("renders a newly created item and authoritative totals without reloading the collection", async () => {
    const browser = harness();
    await flush();
    browser.element("dc-add-btn").focus();
    browser.element("dc-add-btn").dispatch("click");
    browser.element("dc-product-id").value = "123";
    browser.element("dc-quantity").value = "2";
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "new-item",
          product_id: "gid://shopify/Product/123",
          quantity_owned: 2,
          purchase_price: 25,
          in_wishlist: false,
        },
        stats: { total_items: 3, total_value: 75 },
      })),
    });
    browser.element("dc-item-form").dispatch("submit");
    await flush();

    expect(browser.fetch).toHaveBeenCalledTimes(3);
    expect(browser.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(browser.element("dc-item-modal").hidden).toBe(true);
    expect(browser.document.activeElement).toBe(browser.element("dc-add-btn"));
    expect(browser.element("dc-grid").children).toHaveLength(2);
    expect(browser.element("dc-grid").children[0].children[0].textContent).toBe("Shopify Product 123");
    expect(browser.element("dc-stats").children[0].children[1].textContent).toBe("3");
    expect(browser.element("dc-stats").children[1].children[1].textContent).toBe("$75");
    expect(browser.toasts()).toContain("Item added");
  });
  it("renders an edited item and authoritative totals from the mutation response", async () => {
    const browser = harness();
    await flush();
    browser.element("dc-grid").children[0].children[2].children[1].children[1].dispatch("click");
    browser.element("dc-quantity").value = "4";
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "one",
          product_id: "gid://shopify/Product/1",
          quantity_owned: 4,
          user_notes: "Original",
          in_wishlist: false,
        },
        stats: { total_items: 4, total_value: 100 },
      })),
    });
    browser.element("dc-item-form").dispatch("submit");
    await flush();

    expect(browser.fetch).toHaveBeenCalledTimes(3);
    expect(browser.fetch.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
    expect(browser.element("dc-grid").children).toHaveLength(1);
    expect(browser.element("dc-grid").children[0].children[1].children[0].textContent).toBe("Quantity: 4");
    expect(browser.element("dc-stats").children[0].children[1].textContent).toBe("4");
    expect(browser.element("dc-stats").children[1].children[1].textContent).toBe("$100");
    expect(browser.toasts()).toContain("Item updated");
  });
  it("preserves cached totals instead of calculating a subtotal when stats recalculation fails", async () => {
    const browser = harness();
    await flush();
    browser.element("dc-add-btn").dispatch("click");
    browser.element("dc-product-id").value = "456";
    browser.fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({
        data: {
          item_id: "new-item-without-stats",
          product_id: "gid://shopify/Product/456",
          quantity_owned: 5,
          in_wishlist: false,
        },
      })),
    });
    browser.element("dc-item-form").dispatch("submit");
    await flush();

    expect(browser.element("dc-grid").children).toHaveLength(2);
    expect(browser.element("dc-stats").children[0].children[1].textContent).toBe("1");
    expect(browser.toasts()).toContain("Item saved, but totals could not be refreshed.");
  });
  it("focuses and traps the dialog then restores focus on Escape", async () => {
    const browser = harness();
    await flush();
    browser.element("dc-add-btn").focus();
    browser.element("dc-add-btn").dispatch("click");
    expect(browser.document.activeElement).toBe(browser.element("dc-product-id"));
    browser.element("dc-item-modal").dispatch("keydown", { key: "Tab", shiftKey: true });
    expect(browser.document.activeElement).toBe(browser.element("dc-submit-item"));
    browser.element("dc-item-modal").dispatch("keydown", { key: "Tab" });
    expect(browser.document.activeElement).toBe(browser.element("dc-product-id"));
    browser.element("dc-item-modal").dispatch("keydown", { key: "Escape" });
    expect(browser.element("dc-item-modal").hidden).toBe(true);
    expect(browser.document.activeElement).toBe(browser.element("dc-add-btn"));
  });
  it("blocks duplicate pagination requests and allows retry after failure", async () => {
    const browser = harness();
    await flush();
    browser.fetch.mockRejectedValueOnce(new Error("offline"));
    browser.element("dc-load-more").dispatch("click");
    browser.element("dc-load-more").dispatch("click");
    expect(browser.fetch).toHaveBeenCalledTimes(3);
    await flush();
    expect(browser.element("dc-load-more").disabled).toBe(false);
    expect(browser.toasts()).toContain("Could not load more items: offline");
    browser.element("dc-load-more").dispatch("click");
    await flush();
    expect(browser.fetch).toHaveBeenCalledTimes(4);
  });
  it("handles a collection refresh rejection after polling reports completion", async () => {
    const browser = harness();
    await flush();
    browser.element("dc-sync-btn").dispatch("click");
    await flush();
    browser.fetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { stats: {}, syncState: { sync_status: "completed" } } })) });
    browser.fetch.mockRejectedValueOnce(new Error("refresh offline"));
    // Starting sync schedules a toast timeout before its polling timeout.
    browser.timers[1]();
    await flush();
    expect(browser.toasts()).toContain("Sync completed");
    expect(browser.toasts()).toContain("Sync finished, but collection refresh failed: refresh offline");
    expect(browser.element("dc-sync-btn").disabled).toBe(false);
  });
  it("explains unsupported clearing before sending an update", async () => {
    const browser = harness();
    await flush();
    const card = browser.element("dc-grid").children[0];
    const actions = card.children[2].children[1];
    actions.children[1].dispatch("click");
    browser.element("dc-notes").value = "";
    browser.element("dc-item-form").dispatch("submit");
    await flush();
    expect(browser.fetch).toHaveBeenCalledTimes(2);
    expect(browser.element("dc-submit-item").disabled).toBe(false);
    expect(browser.toasts()).toContain("Clearing an existing optional field is not supported. Restore its value before saving.");
  });
});

