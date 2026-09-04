import React from "react";
import { useToast } from "~/hooks/useToast";

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`} role="alert">
          <div className="toast-content">
            <div className="toast-title">{toast.title}</div>
            {toast.description && <div className="toast-desc">{toast.description}</div>}
          </div>
          <button 
            className="btn btn-ghost" 
            style={{ padding: "0.2rem 0.5rem" }}
            onClick={() => removeToast(toast.id)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
