import { useSearchParams, useSubmit } from "react-router";
import { useCallback } from "react";

export function useFilters() {
  const [searchParams] = useSearchParams();
  const submit = useSubmit();

  const setFilter = useCallback((key: string, value: string | undefined) => {
    const newParams = new URLSearchParams(searchParams);
    
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    
    // Reset pagination when filters change
    newParams.delete("after");
    
    submit(newParams, { replace: true, preventScrollReset: true });
  }, [searchParams, submit]);

  const clearFilters = useCallback(() => {
    submit({}, { replace: true, preventScrollReset: true });
  }, [submit]);

  const filters = {
    denomination: searchParams.get("denomination") || undefined,
    country_of_issue: searchParams.get("country_of_issue") || undefined,
    material: searchParams.get("material") || undefined,
    year_of_issue: searchParams.get("year_of_issue") || undefined,
    grade: searchParams.get("grade") || undefined,
    in_wishlist: searchParams.get("in_wishlist") === "true",
  };

  return {
    filters,
    setFilter,
    clearFilters,
    searchParams
  };
}
