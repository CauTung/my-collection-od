import React from "react";
import type { CollectionStats } from "~/types";

interface StatsCardsProps {
  stats: CollectionStats | null;
}

export function StatsCards({ stats }: StatsCardsProps) {
  // Use a fallback of 0 if stats are missing
  const totalItems = stats?.total_items || 0;
  
  // Format currency
  const totalValueFormatted = new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD'
  }).format(stats?.total_value || 0);

  return (
    <div className="stats-grid">
      <div className="stat-card">
        <div className="stat-label">Total Collectibles</div>
        <div className="stat-value">{totalItems}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Estimated Value</div>
        <div className="stat-value">{totalValueFormatted}</div>
      </div>
    </div>
  );
}
