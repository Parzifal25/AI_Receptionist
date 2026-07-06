"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/profile", label: "Business profile" },
  { href: "/dashboard/receptionist", label: "Receptionist" },
  { href: "/dashboard/knowledge", label: "Knowledge base" },
  { href: "/dashboard/faqs", label: "FAQs" },
  { href: "/dashboard/conversations", label: "Conversations" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/install", label: "Install widget" },
  { href: "/dashboard/settings", label: "Settings" },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {LINKS.map(({ href, label }) => {
        const active =
          href === "/dashboard" ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
