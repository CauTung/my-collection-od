import { useFetcher } from "react-router";
import { useCallback } from "react";

export function useCollection() {
  const fetcher = useFetcher();

  const isSubmitting = fetcher.state === "submitting";

  const deleteItem = useCallback((itemId: string) => {
    fetcher.submit(
      { intent: "delete" },
      { method: "DELETE", action: `/api/collection/${itemId}` }
    );
  }, [fetcher]);

  const toggleWishlist = useCallback((itemId: string, currentStatus: boolean) => {
    fetcher.submit(
      { intent: currentStatus ? "remove" : "add" },
      { method: currentStatus ? "DELETE" : "POST", action: `/api/collection/${itemId}/wishlist` }
    );
  }, [fetcher]);

  const triggerSync = useCallback(() => {
    fetcher.submit(
      {},
      { method: "POST", action: "/api/collection/sync" }
    );
  }, [fetcher]);

  return {
    deleteItem,
    toggleWishlist,
    triggerSync,
    isSubmitting,
    fetcher
  };
}
