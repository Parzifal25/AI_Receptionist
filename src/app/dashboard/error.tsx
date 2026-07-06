"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ai-receptionist] dashboard error", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
        This page hit an error
      </h2>
      <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
        Your data is safe. Try reloading — if it keeps happening, contact support.
      </p>
      <Button onClick={reset}>Reload</Button>
    </div>
  );
}
