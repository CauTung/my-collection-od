import React from "react";
import type { CollectionItem } from "~/types";
import { Button } from "~/components/ui/Button";

interface CollectionGridProps {
  items: CollectionItem[];
  onEdit: (item: CollectionItem) => void;
  onDelete: (itemId: string) => void;
  onToggleWishlist: (itemId: string, currentStatus: boolean) => void;
}

export function CollectionGrid({ items, onEdit, onDelete, onToggleWishlist }: CollectionGridProps) {
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--bg-glass)', borderRadius: 'var(--radius-lg)' }}>
        <h3 style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>No items found.</h3>
        <p style={{ color: 'var(--text-tertiary)' }}>Try adjusting your filters or add a new item.</p>
      </div>
    );
  }

  return (
    <div className="collection-grid">
      {items.map((item) => {
        const val = item.current_market_value || item.purchase_price || 0;
        const formattedValue = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(val);
        
        return (
          <div key={item.item_id} className="coin-card">
            <div className="coin-card-image">
              <div className="coin-placeholder">
                {item.quantity_owned > 1 ? `${item.quantity_owned}x` : 'COIN'}
              </div>
              <button 
                className="btn btn-ghost" 
                style={{ position: 'absolute', top: '10px', right: '10px', padding: '0.5rem', background: 'rgba(0,0,0,0.5)', borderRadius: '50%', border: 'none' }}
                onClick={() => onToggleWishlist(item.item_id, item.in_wishlist)}
                title={item.in_wishlist ? "Remove from wishlist" : "Add to wishlist"}
              >
                {item.in_wishlist ? "❤️" : "🤍"}
              </button>
            </div>
            
            <div className="coin-card-content">
              <div className="coin-meta">
                {item.source === "shopify_sync" && <span className="badge">Synced</span>}
                {item.source === "manual_entry" && <span className="badge">Manual</span>}
                {item.user_grade && <span className="badge gold">Grade: {item.user_grade}</span>}
              </div>
              
              {/* Product ID is used as title placeholder for MVP until we fetch real titles */}
              <h3 className="coin-title" title={item.product_id}>
                {item.product_id.split('/').pop()}
              </h3>
              
              {item.user_notes && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', marginBottom: '1rem', fontStyle: 'italic' }}>
                  "{item.user_notes.length > 50 ? item.user_notes.substring(0, 50) + "..." : item.user_notes}"
                </p>
              )}
              
              <div className="coin-footer">
                <div>
                  <div className="coin-value-label">Value</div>
                  <div className="coin-value">{formattedValue}</div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Button variant="ghost" style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }} onClick={() => onEdit(item)}>Edit</Button>
                  <Button variant="danger" style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }} onClick={() => onDelete(item.item_id)}>Delete</Button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
