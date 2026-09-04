import React, { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { extractAppProxySession } from "~/lib/session.server";
import { withErrorHandler } from "~/lib/error-handler.server";
import { getCustomerCollectionMetafields } from "~/lib/metafield.server";
import { listCollectionItems } from "~/lib/metaobject.server";
import type { CollectionItem, CollectionFilters, CollectionStats, CollectionPage } from "~/types";

import { Shell } from "~/components/layout/Shell";
import { StatsCards } from "~/components/dashboard/StatsCards";
import { FilterBar } from "~/components/filters/FilterBar";
import { CollectionGrid } from "~/components/dashboard/CollectionGrid";
import { AddEditModal } from "~/components/forms/AddEditModal";
import { Button } from "~/components/ui/Button";
import { useCollection } from "~/hooks/useCollection";

// --- Loader: Fetch Data (Server) ---
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return withErrorHandler(async () => {
    // 1. Authenticate via App Proxy
    const session = await extractAppProxySession(request);

    // 2. Parse URL Filters
    const url = new URL(request.url);
    const filters: CollectionFilters = {
      denomination: url.searchParams.get("denomination") || undefined,
      country_of_issue: url.searchParams.get("country_of_issue") || undefined,
      material: url.searchParams.get("material") || undefined,
      year_of_issue: url.searchParams.get("year_of_issue") || undefined,
      grade: url.searchParams.get("grade") || undefined,
      in_wishlist: url.searchParams.get("in_wishlist") === "true",
      after: url.searchParams.get("after") || undefined,
      first: parseInt(url.searchParams.get("first") || "50", 10),
    };

    // 3. Fetch Stats (O(1) fast path) and Items (paginated) in parallel
    const [metafieldData, collectionPage] = await Promise.all([
      getCustomerCollectionMetafields(session.customer_id),
      listCollectionItems(session.customer_id, filters),
    ]);

    return Response.json({
      stats: metafieldData?.stats || null,
      collectionPage,
    });
  });
};

type LoaderData = {
  stats: CollectionStats | null;
  collectionPage: CollectionPage;
};

// --- Component: Render UI (Client/SSR) ---
export default function MyCollectionDashboard() {
  const { stats, collectionPage } = useLoaderData() as LoaderData;
  const { deleteItem, toggleWishlist, triggerSync, isSubmitting } = useCollection();
  
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CollectionItem | null>(null);

  const handleOpenAdd = () => {
    setEditingItem(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (item: CollectionItem) => {
    setEditingItem(item);
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setEditingItem(null);
  };

  const headerContent = (
    <div style={{ display: 'flex', gap: '1rem' }}>
      <Button variant="ghost" onClick={triggerSync} loading={isSubmitting}>
        Sync Past Orders
      </Button>
      <Button variant="primary" onClick={handleOpenAdd}>
        + Add Item
      </Button>
    </div>
  );

  return (
    <Shell headerContent={headerContent}>
      <StatsCards stats={stats} />
      
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>My Collection</h2>
        <FilterBar />
      </div>

      <CollectionGrid 
        items={collectionPage.items} 
        onEdit={handleOpenEdit}
        onDelete={deleteItem}
        onToggleWishlist={toggleWishlist}
      />
      
      {/* Pagination (Simplified for MVP) */}
      {collectionPage.pageInfo.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: '2rem' }}>
          <Button variant="ghost">Load More</Button>
        </div>
      )}

      {modalOpen && (
        <AddEditModal 
          item={editingItem} 
          onClose={handleCloseModal} 
        />
      )}
    </Shell>
  );
}
