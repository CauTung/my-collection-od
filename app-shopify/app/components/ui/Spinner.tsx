import React from "react";

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <div className={`spinner ${className}`} aria-label="Loading..." role="status" />
  );
}
