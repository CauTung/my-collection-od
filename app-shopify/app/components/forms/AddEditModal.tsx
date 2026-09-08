import React, { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { CollectionItem } from "~/types";
import { Button } from "~/components/ui/Button";
import { v4 as uuidv4 } from "uuid";
import { useToast } from "~/hooks/useToast";

interface AddEditModalProps {
  item?: CollectionItem | null; // null means "Add" mode
  onClose: () => void;
}

export function AddEditModal({ item, onClose }: AddEditModalProps) {
  const fetcher = useFetcher();
  const { showToast } = useToast();
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");

  const isEdit = !!item;
  const isSubmitting = fetcher.state === "submitting";

  // Generate idempotency key on mount (Rule 3.2: CRUD Idempotency)
  useEffect(() => {
    setIdempotencyKey(uuidv4());
  }, []);

  // Close on successful submission
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { item_id?: string; error?: string };
      if (data.item_id) { // Success signature
        showToast("success", isEdit ? "Item updated successfully!" : "Item added successfully!");
        onClose();
      } else if (data.error) {
        showToast("error", "Error saving item", data.error);
      }
    }
  }, [fetcher.state, fetcher.data, isEdit, onClose, showToast]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <fetcher.Form 
          method={isEdit ? "PUT" : "POST"} 
          action={isEdit ? `/api/collection/${item.item_id}` : "/api/collection"}
        >
          <input type="hidden" name="idempotency_key" value={idempotencyKey} />
          
          <div className="modal-header">
            <h2>{isEdit ? "Edit Item" : "Add New Item"}</h2>
            <button type="button" className="btn btn-ghost" style={{ padding: '0.2rem 0.5rem' }} onClick={onClose}>✕</button>
          </div>
          
          <div className="modal-body">
            {!isEdit && (
              <div className="form-group">
                <label className="form-label" htmlFor="product-id">Product ID</label>
                <input 
                  id="product-id"
                  type="text" 
                  name="product_id" 
                  className="form-input" 
                  inputMode="numeric"
                  pattern="[0-9]+"
                  placeholder="e.g. 123456789"
                  required
                />
                <small className="form-help">Enter the product number from your Shopify product URL.</small>
              </div>
            )}
            
            <div className="form-group">
              <label className="form-label">Quantity</label>
              <input 
                type="number" 
                name="quantity_owned" 
                className="form-input" 
                defaultValue={item?.quantity_owned || 1}
                min={1}
                max={999}
                required
              />
            </div>
            
            <div className="form-group">
              <label className="form-label">Current Market Value (AUD)</label>
              <input 
                type="number" 
                name="current_market_value" 
                className="form-input" 
                defaultValue={item?.current_market_value || ""}
                step="0.01"
                min={0}
              />
            </div>
            
            <div className="form-group">
              <label className="form-label">Certificate Number</label>
              <input 
                type="text" 
                name="certificate_number" 
                className="form-input" 
                defaultValue={item?.certificate_number || ""}
                maxLength={50}
              />
            </div>

            <div className="form-group">
              <label className="form-label">User Grade</label>
              <input 
                type="text" 
                name="user_grade" 
                className="form-input" 
                defaultValue={item?.user_grade || ""}
                maxLength={200}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Personal Notes</label>
              <textarea 
                name="user_notes" 
                className="form-input" 
                defaultValue={item?.user_notes || ""}
                maxLength={500}
                rows={3}
              />
            </div>
          </div>
          
          <div className="modal-footer">
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              {isEdit ? "Save Changes" : "Add to Collection"}
            </Button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}
