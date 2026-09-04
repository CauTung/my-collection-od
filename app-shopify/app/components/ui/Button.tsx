import React from "react";
import { Spinner } from "./Spinner";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, variant = "primary", loading = false, disabled, className = "", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`btn btn-${variant} ${className}`}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Spinner />}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
