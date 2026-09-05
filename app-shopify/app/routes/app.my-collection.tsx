/**
 * app/routes/app.my-collection.tsx
 *
 * Shopify App Proxy entry point.
 *
 * CRITICAL: App Proxy routes MUST return `application/liquid` content type.
 * Shopify injects the response body into the storefront theme layout.
 * Returning a full HTML document (e.g. React SSR) breaks the App Proxy —
 * Shopify shows "There was an error in the third-party application."
 *
 * This route returns a Liquid-compatible HTML fragment with inline CSS and JS
 * that renders the collection dashboard UI. Data fetching is done client-side
 * via fetch() calls to the JSON API routes.
 */

import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxyHmac } from "~/lib/hmac.server";
import { getQueryParams } from "~/lib/session.server";
import { logger } from "~/lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const url = new URL(request.url);
    const params = getQueryParams(request);

    const customerId = params["logged_in_customer_id"] || "";
    const shop = params["shop"] || "";
    const pathPrefix = params["path_prefix"] || "";

    const apiBase = `https://${shop}${pathPrefix}/api/collection`;

    const html = buildDashboardHtml(customerId, shop, pathPrefix, apiBase);

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "application/liquid",
      },
    });
  } catch (error) {
    logger.error("UNHANDLED ERROR in app.my-collection.tsx loader", { error: String(error) });
    return new Response("<div class='dc-app'>Error: " + String(error) + "</div>", {
      status: 200,
      headers: { "Content-Type": "application/liquid" },
    });
  }
};

function buildDashboardHtml(
  customerId: string,
  shop: string,
  pathPrefix: string,
  apiBase: string
): string {
  return `
<style>
  /* Scoped styles for Downies Collection App */
  .dc-app { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #1a1a2e; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
  .dc-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
  .dc-title { font-size: 1.75rem; font-weight: 700; color: #1a1a2e; margin: 0; }
  .dc-title-accent { color: #b8860b; }
  .dc-actions { display: flex; gap: 0.75rem; }
  
  .dc-btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.6rem 1.2rem; border-radius: 8px; font-weight: 500; font-size: 0.9rem; cursor: pointer; border: none; transition: all 0.2s; }
  .dc-btn-primary { background: #b8860b; color: #fff; }
  .dc-btn-primary:hover { background: #9a7209; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(184,134,11,0.3); }
  .dc-btn-ghost { background: transparent; color: #555; border: 1px solid #ddd; }
  .dc-btn-ghost:hover { background: #f5f5f5; border-color: #bbb; }
  .dc-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .dc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .dc-stat { background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 1.25rem; transition: transform 0.2s, box-shadow 0.2s; }
  .dc-stat:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
  .dc-stat-label { font-size: 0.8rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
  .dc-stat-value { font-size: 1.75rem; font-weight: 700; color: #1a1a2e; }

  .dc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem; }
  .dc-card { background: #fff; border: 1px solid #eee; border-radius: 12px; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; }
  .dc-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
  .dc-card-img { height: 180px; background: linear-gradient(135deg, #f8f6f0, #ede8da); display: flex; align-items: center; justify-content: center; }
  .dc-coin-icon { width: 80px; height: 80px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #d4af37, #8b6914); border: 3px solid #c9a227; box-shadow: inset 0 -3px 8px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.2); }
  .dc-card-body { padding: 1.25rem; }
  .dc-card-title { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; color: #1a1a2e; line-height: 1.4; }
  .dc-card-meta { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .dc-badge { background: #f0ead6; color: #8b6914; padding: 0.15rem 0.5rem; border-radius: 20px; font-size: 0.7rem; font-weight: 500; }
  .dc-card-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 0.75rem; border-top: 1px solid #f0f0f0; }
  .dc-card-price { font-size: 1.1rem; font-weight: 700; color: #b8860b; }
  .dc-card-actions { display: flex; gap: 0.5rem; }
  .dc-btn-sm { padding: 0.35rem 0.7rem; font-size: 0.8rem; border-radius: 6px; }
  .dc-btn-icon { background: none; border: 1px solid #eee; cursor: pointer; padding: 0.35rem 0.5rem; border-radius: 6px; font-size: 0.9rem; transition: all 0.15s; }
  .dc-btn-icon:hover { background: #f5f5f5; }
  .dc-btn-icon.wishlisted { color: #ef476f; border-color: #ef476f; }

  .dc-empty { text-align: center; padding: 4rem 2rem; color: #888; }
  .dc-empty-icon { font-size: 3rem; margin-bottom: 1rem; opacity: 0.5; }
  .dc-empty-text { font-size: 1.1rem; margin-bottom: 0.5rem; }
  .dc-empty-sub { font-size: 0.9rem; color: #aaa; }

  .dc-loading { text-align: center; padding: 3rem; color: #888; }
  .dc-spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid #ddd; border-top-color: #b8860b; border-radius: 50%; animation: dc-spin 0.8s linear infinite; }
  @keyframes dc-spin { to { transform: rotate(360deg); } }

  .dc-toast { position: fixed; bottom: 2rem; right: 2rem; background: #1a1a2e; color: #fff; padding: 0.75rem 1.25rem; border-radius: 8px; font-size: 0.9rem; z-index: 10000; box-shadow: 0 4px 16px rgba(0,0,0,0.2); animation: dc-slideUp 0.3s ease; }
  .dc-toast-error { background: #ef476f; }
  @keyframes dc-slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

  .dc-login-prompt { text-align: center; padding: 4rem 2rem; }
  .dc-login-prompt h2 { margin-bottom: 1rem; }
  .dc-login-prompt p { color: #666; margin-bottom: 1.5rem; }
  .dc-login-prompt a { color: #b8860b; font-weight: 600; text-decoration: none; }
  .dc-login-prompt a:hover { text-decoration: underline; }
</style>

<div class="dc-app" id="dc-app">
  ${!customerId ? `
    <div class="dc-login-prompt">
      <h2>My Coin Collection</h2>
      <p>Please log in to view and manage your collection.</p>
      <a href="/account/login">Log In to Your Account →</a>
    </div>
  ` : `
    <div class="dc-loading" id="dc-loading">
      <div class="dc-spinner"></div>
      <p>Loading your collection...</p>
    </div>
    <div id="dc-content" style="display:none;">
      <div class="dc-header">
        <h1 class="dc-title">My <span class="dc-title-accent">Collection</span></h1>
        <div class="dc-actions">
          <button class="dc-btn dc-btn-ghost" id="dc-sync-btn" onclick="dcSyncPurchases()">🔄 Sync Past Orders</button>
          <button class="dc-btn dc-btn-primary" id="dc-add-btn" onclick="dcShowAddForm()">+ Add Item</button>
        </div>
      </div>

      <div class="dc-stats" id="dc-stats"></div>
      <div class="dc-grid" id="dc-grid"></div>
    </div>
  `}
</div>
</div>

<template id="dc-add-modal-template">
  <div id="dc-add-modal" style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:9999;">
    <div style="background:#fff; padding:2rem; border-radius:12px; width:400px; max-width:90%;">
      <h3 style="margin-top:0;">Add New Coin</h3>
      <input type="text" id="dc-input-title" placeholder="Coin Title" style="width:100%; margin-bottom:1rem; padding:0.5rem; border:1px solid #ccc; border-radius:4px;" />
      <input type="number" id="dc-input-value" placeholder="Estimated Value ($)" style="width:100%; margin-bottom:1rem; padding:0.5rem; border:1px solid #ccc; border-radius:4px;" />
      <input type="text" id="dc-input-country" placeholder="Country" style="width:100%; margin-bottom:1rem; padding:0.5rem; border:1px solid #ccc; border-radius:4px;" />
      <div style="display:flex; justify-content:flex-end; gap:1rem;">
        <button class="dc-btn dc-btn-ghost" onclick="dcCloseAddForm()">Cancel</button>
        <button class="dc-btn dc-btn-primary" onclick="dcSubmitItem()">Save Item</button>
      </div>
    </div>
  </div>
</template>

${customerId ? `
<script>
(function() {
  var CUSTOMER_ID = "${customerId}";
  var SHOP = "${shop}";
  var PATH_PREFIX = "${pathPrefix}";

  // Build API URL that goes through the App Proxy
  function apiUrl(path) {
    return PATH_PREFIX + "/api/collection" + (path || "");
  }

  // Fetch wrapper that handles errors
  function apiFetch(path, options) {
    var url = apiUrl(path);
    options = options || {};
    options.headers = options.headers || {};
    options.headers["Content-Type"] = "application/json";
    options.credentials = "same-origin";
    return fetch(url, options)
      .then(function(res) {
        if (!res.ok) throw new Error("API error: " + res.status);
        return res.json();
      });
  }

  function showToast(msg, isError) {
    var el = document.createElement("div");
    el.className = "dc-toast" + (isError ? " dc-toast-error" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3000);
  }

  function renderStats(stats) {
    var container = document.getElementById("dc-stats");
    if (!stats) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML =
      '<div class="dc-stat"><div class="dc-stat-label">Total Items</div><div class="dc-stat-value">' + (stats.total_items || 0) + '</div></div>' +
      '<div class="dc-stat"><div class="dc-stat-label">Collection Value</div><div class="dc-stat-value">$' + (stats.total_value || 0).toLocaleString() + '</div></div>';
  }

  function renderGrid(items) {
    var container = document.getElementById("dc-grid");
    if (!items || items.length === 0) {
      container.innerHTML =
        '<div class="dc-empty" style="grid-column: 1/-1;">' +
        '<div class="dc-empty-icon">🪙</div>' +
        '<div class="dc-empty-text">No items in your collection yet</div>' +
        '<div class="dc-empty-sub">Click "Sync Past Orders" to import purchases, or "Add Item" to add manually.</div>' +
        '</div>';
      return;
    }

    container.innerHTML = items.map(function(item) {
      var badges = [];
      if (item.country_of_issue) badges.push(item.country_of_issue);
      if (item.year_of_issue) badges.push(item.year_of_issue);
      if (item.material) badges.push(item.material);

      return '<div class="dc-card">' +
        '<div class="dc-card-img">' +
          (item.image_url
            ? '<img src="' + item.image_url + '" alt="' + (item.product_title || "Coin") + '" style="max-height:100%;max-width:100%;object-fit:contain;" />'
            : '<div class="dc-coin-icon"></div>') +
        '</div>' +
        '<div class="dc-card-body">' +
          '<h3 class="dc-card-title">' + (item.product_title || "Unknown Item") + '</h3>' +
          '<div class="dc-card-meta">' + badges.map(function(b) { return '<span class="dc-badge">' + b + '</span>'; }).join("") + '</div>' +
          (item.denomination ? '<div style="font-size:0.85rem;color:#666;margin-bottom:0.5rem;">Denomination: ' + item.denomination + '</div>' : '') +
          '<div class="dc-card-footer">' +
            '<div class="dc-card-price">' + (item.estimated_value ? "$" + Number(item.estimated_value).toLocaleString() : "—") + '</div>' +
            '<div class="dc-card-actions">' +
              '<button class="dc-btn-icon' + (item.in_wishlist ? ' wishlisted' : '') + '" onclick="dcToggleWishlist(\\'' + item.id + '\\', ' + !item.in_wishlist + ')" title="Wishlist">' + (item.in_wishlist ? "❤️" : "🤍") + '</button>' +
              '<button class="dc-btn-icon" onclick="dcDeleteItem(\\'' + item.id + '\\')" title="Delete">🗑️</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  // Load initial data
  function loadData() {
    apiFetch("/stats")
      .then(function(data) { renderStats(data.stats || data); })
      .catch(function(err) { console.warn("Stats load error:", err); });

    apiFetch("")
      .then(function(data) {
        var items = data.items || data.collectionPage?.items || [];
        renderGrid(items);
        document.getElementById("dc-loading").style.display = "none";
        document.getElementById("dc-content").style.display = "block";
      })
      .catch(function(err) {
        console.error("Collection load error:", err);
        document.getElementById("dc-loading").innerHTML =
          '<p style="color:#ef476f;">Failed to load collection. Please try refreshing.</p>';
      });
  }

  // Global functions for onclick handlers
  window.dcSyncPurchases = function() {
    var btn = document.getElementById("dc-sync-btn");
    btn.disabled = true;
    btn.textContent = "Syncing...";
    apiFetch("/sync", { method: "POST" })
      .then(function() {
        showToast("Sync started! Refreshing...");
        setTimeout(loadData, 2000);
      })
      .catch(function(err) { showToast("Sync failed: " + err.message, true); })
      .finally(function() { btn.disabled = false; btn.textContent = "🔄 Sync Past Orders"; });
  };

  window.dcToggleWishlist = function(itemId, value) {
    apiFetch("/" + itemId + "/wishlist", {
      method: "PUT",
      body: JSON.stringify({ in_wishlist: value })
    })
    .then(function() { loadData(); })
    .catch(function(err) { showToast("Failed: " + err.message, true); });
  };

  window.dcDeleteItem = function(itemId) {
    if (!confirm("Remove this item from your collection?")) return;
    apiFetch("/" + itemId, { method: "DELETE" })
      .then(function() { showToast("Item removed"); loadData(); })
      .catch(function(err) { showToast("Failed: " + err.message, true); });
  };

  window.dcShowAddForm = function() {
    if (document.getElementById('dc-add-modal')) return;
    var template = document.getElementById('dc-add-modal-template');
    var clone = template.content.cloneNode(true);
    document.body.appendChild(clone);
  };

  window.dcCloseAddForm = function() {
    var modal = document.getElementById('dc-add-modal');
    if (modal) modal.remove();
  };

  window.dcSubmitItem = function() {
    var title = document.getElementById("dc-input-title").value;
    var value = document.getElementById("dc-input-value").value;
    var country = document.getElementById("dc-input-country").value;
    
    if (!title) { showToast("Title is required", true); return; }
    
    // Generate simple idempotency key
    var idempotencyKey = "key-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
    
    apiFetch("", {
      method: "POST",
      body: JSON.stringify({
        product_title: title,
        estimated_value: value ? parseFloat(value) : 0,
        country_of_issue: country,
        idempotency_key: idempotencyKey,
        is_coin: true
      })
    })
    .then(function() {
      document.getElementById('dc-add-modal').remove();
      showToast("Item added!");
      loadData();
    })
    .catch(function(err) {
      showToast("Failed: " + err.message, true);
    });
  };

  // Initialize
  loadData();
})();
</script>
` : ""}
`;
}
