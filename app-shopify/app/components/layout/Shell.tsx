import React from "react";
import { ToastProvider } from "~/hooks/useToast";
import { ToastContainer } from "~/components/ui/Toast";

interface ShellProps {
  children: React.ReactNode;
  headerContent?: React.ReactNode;
}

export function Shell({ children, headerContent }: ShellProps) {
  return (
    <ToastProvider>
      <div className="app-shell">
        <header className="app-header">
          <h1 className="app-title">Downies My Collection</h1>
          {headerContent && <div>{headerContent}</div>}
        </header>
        <main className="app-main">
          {children}
        </main>
      </div>
      <ToastContainer />
    </ToastProvider>
  );
}
