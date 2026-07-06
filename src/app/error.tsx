"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ai-receptionist] page error", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center dark:bg-slate-950">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Something went wrong</h1>
      <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
        An unexpected error occurred. Our team has been notified — please try again.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
