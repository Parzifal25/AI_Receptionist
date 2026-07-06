import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, Card, EmptyState } from "@/components/ui/card";

export const metadata: Metadata = { title: "Conversations — AI Receptionist" };

const PAGE_SIZE = 25;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { businessId } = await requireBusiness();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const supabase = await createSupabaseServerClient();
  const { data: conversations, count } = await supabase
    .from("conversations")
    .select("id, channel, status, message_count, page_url, started_at, last_message_at", {
      count: "exact",
    })
    .eq("business_id", businessId)
    .order("started_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Conversations</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Every chat and voice conversation your receptionist has had.
        </p>
      </div>

      <Card>
        {(conversations ?? []).length === 0 ? (
          <EmptyState
            title="No conversations yet"
            description="Once the widget is installed on your website, visitor conversations appear here."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {conversations!.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  href={`/dashboard/conversations/${conversation.id}`}
                  className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {new Date(conversation.started_at).toLocaleString()}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {conversation.message_count} messages
                      {conversation.page_url && ` · ${conversation.page_url}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={conversation.channel === "voice" ? "blue" : "slate"}>
                      {conversation.channel}
                    </Badge>
                    <Badge tone={conversation.status === "active" ? "green" : "slate"}>
                      {conversation.status}
                    </Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/dashboard/conversations?page=${page - 1}`}
                className="font-medium text-indigo-600 hover:text-indigo-500"
              >
                ← Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/dashboard/conversations?page=${page + 1}`}
                className="font-medium text-indigo-600 hover:text-indigo-500"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
