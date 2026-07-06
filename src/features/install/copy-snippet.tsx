"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopySnippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      <pre className="overflow-x-auto rounded-lg bg-slate-950 px-4 py-3 text-xs leading-relaxed text-slate-100">
        <code>{snippet}</code>
      </pre>
      <Button variant="secondary" size="sm" onClick={copy}>
        {copied ? "Copied!" : "Copy to clipboard"}
      </Button>
    </div>
  );
}
