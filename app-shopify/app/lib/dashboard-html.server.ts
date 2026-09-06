/**
 * Storefront App Proxy dashboard renderer.
 *
 * The fragment is shared by both proxy entry routes. Dynamic collection data is
 * rendered with DOM text properties instead of HTML concatenation, and the only
 * server value embedded in JavaScript is serialized for inline-script context.
 */

import {
  APP_PROXY_DEFAULT_PATH_PREFIX,
  COLLECTION_PAGE_SIZE,
  DASHBOARD_SYNC_POLL_INTERVAL_MS,
  DASHBOARD_SYNC_POLL_MAX_ATTEMPTS,
  DASHBOARD_TOAST_DURATION_MS,
  HISTORICAL_SYNC_LOOKBACK_YEARS,
  MAX_QUANTITY_OWNED,
  MAX_CERTIFICATE_NUMBER_LENGTH,
  MAX_USER_GRADE_LENGTH,
  MAX_USER_NOTES_LENGTH,
} from "~/config/constants";

/**
 * Build the Liquid-compatible collection dashboard fragment.
 *
 * @param pathPrefix - Signed Shopify App Proxy prefix.
 * @returns HTML, CSS, and browser JavaScript for the authenticated dashboard.
 */
export function buildDashboardHtml(pathPrefix: string): string {
  const apiBase = `${normalizePathPrefix(pathPrefix)}/api/collection`;
  const serializedApiBase = serializeInlineScriptValue(apiBase);

  return `
<style>
  .dc-app { color:#1a1a2e; font-family:Inter,system-ui,-apple-system,sans-serif; margin:2rem auto; max-width:1200px; padding:0 1rem; }
  .dc-header,.dc-actions,.dc-card-footer,.dc-form-actions { align-items:center; display:flex; gap:.75rem; justify-content:space-between; }
  .dc-header { flex-wrap:wrap; margin-bottom:1.5rem; }
  .dc-title { font-size:1.75rem; margin:0; }
  .dc-title-accent,.dc-card-price { color:#b8860b; }
  .dc-btn { border:1px solid #ddd; border-radius:8px; cursor:pointer; font:inherit; padding:.6rem 1rem; }
  .dc-btn-primary { background:#b8860b; border-color:#b8860b; color:#fff; }
  .dc-btn-ghost { background:#fff; color:#333; }
  .dc-btn-danger { background:#fff; border-color:#c62828; color:#c62828; }
  .dc-btn:disabled { cursor:not-allowed; opacity:.55; }
  .dc-stats { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin-bottom:1.5rem; }
  .dc-stat,.dc-card { background:#fff; border:1px solid #e5e5e5; border-radius:12px; }
  .dc-stat { padding:1rem; }
  .dc-stat-label { color:#666; font-size:.78rem; letter-spacing:.04em; text-transform:uppercase; }
  .dc-stat-value { font-size:1.5rem; font-weight:700; margin-top:.3rem; }
  .dc-sync-detail { color:#666; font-size:.85rem; margin:-.75rem 0 1.5rem; min-height:1.2em; }
  .dc-grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); }
  .dc-card { padding:1rem; }
  .dc-card-title { font-size:1rem; margin:0 0 .75rem; overflow-wrap:anywhere; }
  .dc-card-meta { color:#555; display:grid; font-size:.86rem; gap:.3rem; margin-bottom:1rem; }
  .dc-card-price { font-size:1.05rem; font-weight:700; }
  .dc-card-actions { display:flex; gap:.4rem; }
  .dc-empty,.dc-loading { color:#777; grid-column:1/-1; padding:3rem 1rem; text-align:center; }
  .dc-load-more { display:block; margin:1.25rem auto 0; }
  .dc-toast { background:#1a1a2e; border-radius:8px; bottom:2rem; color:#fff; padding:.75rem 1rem; position:fixed; right:2rem; z-index:10001; }
  .dc-toast-error { background:#c62828; }
  .dc-modal { align-items:center; background:rgba(0,0,0,.55); display:flex; inset:0; justify-content:center; padding:1rem; position:fixed; z-index:10000; }
  .dc-modal[hidden] { display:none; }
  .dc-dialog { background:#fff; border-radius:12px; max-height:90vh; max-width:520px; overflow:auto; padding:1.5rem; width:100%; }
  .dc-dialog h2 { margin-top:0; }
  .dc-form-grid { display:grid; gap:.85rem; grid-template-columns:1fr 1fr; }
  .dc-field { display:flex; flex-direction:column; font-size:.85rem; gap:.3rem; }
  .dc-field-wide { grid-column:1/-1; }
  .dc-field input,.dc-field textarea { border:1px solid #bbb; border-radius:6px; font:inherit; padding:.55rem; }
  .dc-checkbox { align-items:center; display:flex; gap:.5rem; }
  .dc-form-actions { justify-content:flex-end; margin-top:1rem; }
  @media (max-width:600px) { .dc-form-grid { grid-template-columns:1fr; } .dc-field-wide { grid-column:auto; } }
</style>

<section class="dc-app" id="dc-app">
  <div class="dc-loading" id="dc-loading" role="status">Loading your collection...</div>
  <div id="dc-content" hidden>
    <header class="dc-header">
      <h1 class="dc-title">My <span class="dc-title-accent">Collection</span></h1>
      <div class="dc-actions">
        <button class="dc-btn dc-btn-ghost" id="dc-sync-btn" type="button">Sync Past Orders</button>
        <button class="dc-btn dc-btn-primary" id="dc-add-btn" type="button">Add Item</button>
      </div>
    </header>
    <div class="dc-stats" id="dc-stats"></div>
    <p class="dc-sync-detail" id="dc-sync-detail" aria-live="polite"></p>
    <div class="dc-grid" id="dc-grid"></div>
    <button class="dc-btn dc-btn-ghost dc-load-more" id="dc-load-more" type="button" hidden>Load More</button>
  </div>
</section>

<div class="dc-modal" id="dc-item-modal" role="dialog" aria-modal="true" aria-labelledby="dc-modal-title" hidden>
  <form class="dc-dialog" id="dc-item-form">
    <h2 id="dc-modal-title">Add Item</h2>
    <div class="dc-form-grid">
      <label class="dc-field dc-field-wide" id="dc-product-field">Shopify Product GID
        <input id="dc-product-id" name="product_id" required placeholder="gid://shopify/Product/123456" />
      </label>
      <label class="dc-field">Quantity
        <input id="dc-quantity" name="quantity_owned" type="number" min="1" max="${MAX_QUANTITY_OWNED}" required />
      </label>
      <label class="dc-field">Purchase date
        <input id="dc-purchase-date" name="purchase_date" type="date" />
      </label>
      <label class="dc-field">Purchase price (AUD)
        <input id="dc-purchase-price" name="purchase_price" type="number" min="0" step="0.01" />
      </label>
      <label class="dc-field">Declared value (AUD)
        <input id="dc-market-value" name="current_market_value" type="number" min="0" step="0.01" />
      </label>
      <label class="dc-field">Certificate number
        <input id="dc-certificate" name="certificate_number" maxlength="${MAX_CERTIFICATE_NUMBER_LENGTH}" />
      </label>
      <label class="dc-field">Grade
        <input id="dc-grade" name="user_grade" maxlength="${MAX_USER_GRADE_LENGTH}" />
      </label>
      <label class="dc-field dc-field-wide">Notes
        <textarea id="dc-notes" name="user_notes" maxlength="${MAX_USER_NOTES_LENGTH}" rows="3"></textarea>
      </label>
      <label class="dc-checkbox dc-field-wide">
        <input id="dc-in-wishlist" name="in_wishlist" type="checkbox" /> Add to wishlist
      </label>
    </div>
    <div class="dc-form-actions">
      <button class="dc-btn dc-btn-ghost" id="dc-cancel-item" type="button">Cancel</button>
      <button class="dc-btn dc-btn-primary" id="dc-submit-item" type="submit">Save Item</button>
    </div>
  </form>
</div>

<script>
(function () {
  "use strict";
  var API_BASE = ${serializedApiBase};
  var PAGE_SIZE = ${COLLECTION_PAGE_SIZE};
  var POLL_INTERVAL_MS = ${DASHBOARD_SYNC_POLL_INTERVAL_MS};
  var POLL_MAX_ATTEMPTS = ${DASHBOARD_SYNC_POLL_MAX_ATTEMPTS};
  var TOAST_DURATION_MS = ${DASHBOARD_TOAST_DURATION_MS};
  var LOOKBACK_YEARS = ${HISTORICAL_SYNC_LOOKBACK_YEARS};
  var currentItems = [];
  var nextCursor = null;
  var formState = null;
  var formOpener = null;
  var syncPollGeneration = 0;

  function byId(id) { return document.getElementById(id); }
  function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
  function appendText(parent, tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }
  function numericValue(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  function optionalText(id, payload, key) {
    var value = byId(id).value.trim();
    if (value) payload[key] = value;
  }
  function optionalNumber(id, payload, key) {
    var value = byId(id).value;
    if (value !== "") payload[key] = Number(value);
  }
  function apiUrl(path) { return API_BASE + (path || ""); }
  function apiFetch(path, options) {
    var requestOptions = options || {};
    requestOptions.credentials = "same-origin";
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, { "Content-Type": "application/json" });
    return fetch(apiUrl(path), requestOptions).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        if (text) {
          try { payload = JSON.parse(text); } catch (_error) { throw new Error("API returned an invalid response"); }
        }
        if (!response.ok) {
          var message = payload && payload.error && payload.error.message;
          throw new Error(message || ("API request failed with status " + response.status));
        }
        return payload;
      });
    });
  }
  function showToast(message, isError) {
    var toast = appendText(document.body, "div", "dc-toast" + (isError ? " dc-toast-error" : ""), message);
    toast.setAttribute("role", "status");
    setTimeout(function () { toast.remove(); }, TOAST_DURATION_MS);
  }
  function renderStats(stats) {
    var container = byId("dc-stats");
    clear(container);
    var itemsCard = appendText(container, "div", "dc-stat", "");
    appendText(itemsCard, "div", "dc-stat-label", "Total Items");
    appendText(itemsCard, "div", "dc-stat-value", String(numericValue(stats && stats.total_items)));
    var valueCard = appendText(container, "div", "dc-stat", "");
    appendText(valueCard, "div", "dc-stat-label", "Collection Value");
    appendText(valueCard, "div", "dc-stat-value", "$" + numericValue(stats && stats.total_value).toLocaleString());
  }
  function syncStateStatus(syncState) {
    return syncState && typeof syncState.sync_status === "string" ? syncState.sync_status : "idle";
  }
  function renderSyncState(syncState) {
    var status = syncStateStatus(syncState);
    var progress = syncState && syncState.sync_progress;
    var detail = byId("dc-sync-detail");
    var button = byId("dc-sync-btn");
    if (status === "queued") {
      button.disabled = true;
      button.textContent = "Sync queued";
      detail.textContent = "Your sync is waiting for capacity.";
    } else if (status === "syncing") {
      button.disabled = true;
      button.textContent = "Syncing...";
      detail.textContent = progress ? ("Processed " + progress.processed + " of " + progress.total + "; failed " + progress.failed + ".") : "Sync in progress.";
    } else {
      button.disabled = false;
      button.textContent = "Sync Past " + LOOKBACK_YEARS + " Years";
      detail.textContent = status === "failed" ? "The last sync failed. You can retry." : "";
    }
  }
  function renderGrid(items) {
    var container = byId("dc-grid");
    clear(container);
    if (!items.length) {
      appendText(container, "div", "dc-empty", "No items yet. Sync past orders or add an item manually.");
      return;
    }
    items.forEach(function (item) {
      var card = appendText(container, "article", "dc-card", "");
      var productSegment = String(item.product_id || "Unknown product").split("/").pop();
      appendText(card, "h2", "dc-card-title", item.sku_code || ("Shopify Product " + productSegment));
      var meta = appendText(card, "div", "dc-card-meta", "");
      appendText(meta, "span", "", "Quantity: " + numericValue(item.quantity_owned));
      if (item.purchase_date) appendText(meta, "span", "", "Purchased: " + item.purchase_date);
      if (item.certificate_number) appendText(meta, "span", "", "Certificate: " + item.certificate_number);
      if (item.user_grade) appendText(meta, "span", "", "Grade: " + item.user_grade);
      if (item.user_notes) appendText(meta, "span", "", "Notes: " + item.user_notes);
      var footer = appendText(card, "div", "dc-card-footer", "");
      var value = item.current_market_value != null ? item.current_market_value : item.purchase_price;
      appendText(footer, "div", "dc-card-price", value != null ? ("$" + numericValue(value).toLocaleString()) : "No value");
      var actions = appendText(footer, "div", "dc-card-actions", "");
      var wishlist = appendText(actions, "button", "dc-btn dc-btn-ghost", item.in_wishlist ? "Unwishlist" : "Wishlist");
      wishlist.type = "button";
      wishlist.addEventListener("click", function () { toggleWishlist(item); });
      var edit = appendText(actions, "button", "dc-btn dc-btn-ghost", "Edit");
      edit.type = "button";
      edit.addEventListener("click", function () { openItemForm(item); });
      var remove = appendText(actions, "button", "dc-btn dc-btn-danger", "Delete");
      remove.type = "button";
      remove.addEventListener("click", function () { deleteItem(item); });
    });
  }
  function loadStats() {
    return apiFetch("/stats").then(function (payload) {
      var data = payload && payload.data;
      if (!data) throw new Error("Stats response is missing data");
      renderStats(data.stats);
      renderSyncState(data.syncState);
      return data.syncState;
    });
  }
  function loadCollection(after, append) {
    var path = "?first=" + PAGE_SIZE + (after ? ("&after=" + encodeURIComponent(after)) : "");
    return apiFetch(path).then(function (payload) {
      var items = payload && Array.isArray(payload.data) ? payload.data : [];
      currentItems = append ? currentItems.concat(items) : items;
      nextCursor = payload && payload.pageInfo && payload.pageInfo.hasNextPage ? payload.pageInfo.endCursor : null;
      byId("dc-load-more").hidden = !nextCursor;
      renderGrid(currentItems);
    });
  }
  function loadData() {
    return Promise.all([loadStats(), loadCollection(null, false)]).then(function (results) {
      byId("dc-loading").hidden = true;
      byId("dc-content").hidden = false;
      var state = results[0];
      var status = syncStateStatus(state);
      if (status === "queued" || status === "syncing") startSyncPolling();
    }).catch(function (error) {
      byId("dc-loading").textContent = "Failed to load collection: " + error.message;
    });
  }
  function startSyncPolling() {
    var generation = ++syncPollGeneration;
    var attempts = 0;
    function poll() {
      if (generation !== syncPollGeneration) return;
      attempts += 1;
      loadStats().then(function (state) {
        var status = syncStateStatus(state);
        if (status === "queued" || status === "syncing") {
          if (attempts < POLL_MAX_ATTEMPTS) setTimeout(poll, POLL_INTERVAL_MS);
          else {
            syncPollGeneration += 1;
            byId("dc-sync-btn").disabled = false;
            showToast("Sync is still running. Refresh the page to check again.", true);
          }
          return;
        }
        syncPollGeneration += 1;
        if (status === "completed") showToast("Sync completed");
        else if (status === "failed") showToast("Sync finished with errors. You can retry.", true);
        return loadCollection(null, false).catch(function (error) {
          showToast("Sync finished, but collection refresh failed: " + error.message, true);
        });
      }).catch(function (error) {
        syncPollGeneration += 1;
        byId("dc-sync-btn").disabled = false;
        showToast("Could not check sync status: " + error.message, true);
      });
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  }
  function triggerSync() {
    var button = byId("dc-sync-btn");
    button.disabled = true;
    button.textContent = "Starting sync...";
    apiFetch("/sync", { method: "POST", body: "{}" }).then(function (payload) {
      var status = payload && payload.status;
      renderSyncState({ sync_status: status, sync_progress: null });
      showToast(status === "queued" ? "Sync queued" : "Sync started");
      startSyncPolling();
    }).catch(function (error) {
      button.disabled = false;
      button.textContent = "Sync Past " + LOOKBACK_YEARS + " Years";
      showToast("Sync failed: " + error.message, true);
    });
  }
  function setInput(id, value) { byId(id).value = value == null ? "" : String(value); }
  function openItemForm(item) {
    formOpener = document.activeElement;
    formState = { itemId: item ? item.item_id : null, idempotencyKey: crypto.randomUUID(), submitting: false };
    byId("dc-modal-title").textContent = item ? "Edit Item" : "Add Item";
    byId("dc-product-field").hidden = Boolean(item);
    setInput("dc-product-id", item && item.product_id);
    setInput("dc-quantity", item ? item.quantity_owned : 1);
    setInput("dc-purchase-date", item && item.purchase_date);
    setInput("dc-purchase-price", item && item.purchase_price);
    setInput("dc-market-value", item && item.current_market_value);
    setInput("dc-certificate", item && item.certificate_number);
    setInput("dc-grade", item && item.user_grade);
    setInput("dc-notes", item && item.user_notes);
    byId("dc-in-wishlist").checked = Boolean(item && item.in_wishlist);
    byId("dc-submit-item").disabled = false;
    byId("dc-item-modal").hidden = false;
    byId(item ? "dc-quantity" : "dc-product-id").focus();
  }
  function closeItemForm() {
    if (formState && formState.submitting) return;
    byId("dc-item-modal").hidden = true;
    formState = null;
    if (formOpener && formOpener.isConnected) formOpener.focus();
  }
  function handleDialogKey(event) {
    if (!formState) return;
    if (event.key === "Escape") { event.preventDefault(); closeItemForm(); return; }
    if (event.key !== "Tab") return;
    var first = byId(formState.itemId ? "dc-quantity" : "dc-product-id");
    var last = byId(byId("dc-submit-item").disabled ? "dc-cancel-item" : "dc-submit-item");
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function submitItem(event) {
    event.preventDefault();
    if (!formState || formState.submitting) return;
    formState.submitting = true;
    var submit = byId("dc-submit-item");
    submit.disabled = true;
    var payload = {
      idempotency_key: formState.idempotencyKey,
      quantity_owned: Number(byId("dc-quantity").value),
      in_wishlist: byId("dc-in-wishlist").checked
    };
    optionalText("dc-purchase-date", payload, "purchase_date");
    optionalNumber("dc-purchase-price", payload, "purchase_price");
    optionalNumber("dc-market-value", payload, "current_market_value");
    optionalText("dc-certificate", payload, "certificate_number");
    optionalText("dc-grade", payload, "user_grade");
    optionalText("dc-notes", payload, "user_notes");
    if (!formState.itemId) payload.product_id = byId("dc-product-id").value.trim();
    var path = formState.itemId ? ("/" + encodeURIComponent(formState.itemId)) : "";
    var method = formState.itemId ? "PUT" : "POST";
    apiFetch(path, { method: method, body: JSON.stringify(payload) }).then(function () {
      formState.submitting = false;
      closeItemForm();
      showToast(method === "POST" ? "Item added" : "Item updated");
      return Promise.all([loadStats(), loadCollection(null, false)]).catch(function (error) {
        showToast("Item saved, but collection refresh failed: " + error.message, true);
      });
    }).catch(function (error) {
      formState.submitting = false;
      submit.disabled = false;
      showToast("Save failed: " + error.message, true);
    });
  }
  function toggleWishlist(item) {
    var method = item.in_wishlist ? "DELETE" : "POST";
    apiFetch("/" + encodeURIComponent(item.item_id) + "/wishlist", { method: method }).then(function () {
      showToast(item.in_wishlist ? "Removed from wishlist" : "Added to wishlist");
      return loadCollection(null, false);
    }).catch(function (error) { showToast("Wishlist failed: " + error.message, true); });
  }
  function deleteItem(item) {
    if (!confirm("Remove this item from your collection?")) return;
    apiFetch("/" + encodeURIComponent(item.item_id), { method: "DELETE" }).then(function () {
      showToast("Item removed");
      return Promise.all([loadStats(), loadCollection(null, false)]);
    }).catch(function (error) { showToast("Delete failed: " + error.message, true); });
  }

  byId("dc-sync-btn").addEventListener("click", triggerSync);
  byId("dc-add-btn").addEventListener("click", function () { openItemForm(null); });
  byId("dc-cancel-item").addEventListener("click", closeItemForm);
  byId("dc-item-form").addEventListener("submit", submitItem);
  byId("dc-item-modal").addEventListener("keydown", handleDialogKey);
  byId("dc-load-more").addEventListener("click", function () {
    var button = byId("dc-load-more");
    if (!nextCursor || button.disabled) return;
    button.disabled = true;
    loadCollection(nextCursor, true).catch(function (error) {
      showToast("Could not load more items: " + error.message, true);
    }).finally(function () { button.disabled = false; });
  });
  loadData();
})();
</script>`;
}

function normalizePathPrefix(pathPrefix: string): string {
  const candidate = pathPrefix || APP_PROXY_DEFAULT_PATH_PREFIX;
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\\\s?#]/.test(candidate)) {
    return APP_PROXY_DEFAULT_PATH_PREFIX;
  }
  return candidate.replace(/\/+$/, "");
}

function serializeInlineScriptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
