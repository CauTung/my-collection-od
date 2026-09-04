import React from "react";
import { useFilters } from "~/hooks/useFilters";

export function FilterBar() {
  const { filters, setFilter, clearFilters } = useFilters();

  return (
    <div className="filter-bar">
      <input
        type="text"
        className="form-input filter-input"
        placeholder="Filter by Denomination..."
        value={filters.denomination || ""}
        onChange={(e) => setFilter("denomination", e.target.value)}
      />
      <input
        type="text"
        className="form-input filter-input"
        placeholder="Filter by Country..."
        value={filters.country_of_issue || ""}
        onChange={(e) => setFilter("country_of_issue", e.target.value)}
      />
      
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)' }}>
        <input 
          type="checkbox" 
          checked={filters.in_wishlist}
          onChange={(e) => setFilter("in_wishlist", e.target.checked ? "true" : undefined)}
        />
        Wishlist Only
      </label>

      {Object.values(filters).some(Boolean) && (
        <button className="btn btn-ghost" onClick={clearFilters} style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem" }}>
          Clear Filters
        </button>
      )}
    </div>
  );
}
