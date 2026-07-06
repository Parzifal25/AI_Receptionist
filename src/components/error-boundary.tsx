"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Generic client error boundary for widget-adjacent UI (dashboard pages get
 * Next.js error.tsx files; this covers embedded client trees).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error("[ai-receptionist] component crashed", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            Something went wrong rendering this section.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
