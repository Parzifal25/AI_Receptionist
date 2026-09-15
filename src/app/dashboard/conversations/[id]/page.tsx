import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@halo/platform/cn";

export const metadata: Metadata = { title: "Conversation — AI Receptionist" };

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { businessId } = await requireBusiness();
  const { id } = await params;

  const supabase = await createSupabaseServerClient();
  const [{ data: conversation }, { data: messages }, { data: lead }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, channel, status, page_url, started_at")
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", id)
      .eq("business_id", businessId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true }),
    supabase
      .from("leads")
      .select("id, name, email, phone, intent")
      .eq("conversation_id", id)
      .eq("business_id", businessId)
      .maybeSingle(),
  ]);

  if (!conversation) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link
          href="/dashboard/conversations"
          className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
        >
          ← All conversations
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            {new Date(conversation.started_at).toLocaleString()}
          </h1>
          <Badge tone={conversation.channel === "voice" ? "blue" : "slate"}>
            {conversation.channel}
          </Badge>
        </div>
        {conversation.page_url && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Started on {conversation.page_url}
          </p>
        )}
      </div>

      {lead && (
        <Card>
          <CardHeader
            title="Lead captured"
            action={
              <Link
                href="/dashboard/leads"
                className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
              >
                View in leads
              </Link>
            }
          />
          <CardBody className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-slate-500 dark:text-slate-400">Name</p>
              <p className="font-medium text-slate-900 dark:text-slate-100">{lead.name || "—"}</p>
            </div>
            <div>
              <p className="text-slate-500 dark:text-slate-400">Email</p>
              <p className="font-medium text-slate-900 dark:text-slate-100">{lead.email || "—"}</p>
            </div>
            <div>
              <p className="text-slate-500 dark:text-slate-400">Phone</p>
              <p className="font-medium text-slate-900 dark:text-slate-100">{lead.phone || "—"}</p>
            </div>
            <div>
              <p className="text-slate-500 dark:text-slate-400">Intent</p>
              <p className="font-medium text-slate-900 dark:text-slate-100">{lead.intent || "—"}</p>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-4">
          {(messages ?? []).map((message) => (
            <div
              key={message.id}
              className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm",
                  message.role === "user"
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
                )}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
                <p
                  className={cn(
                    "mt-1 text-[10px]",
                    message.role === "user" ? "text-indigo-200" : "text-slate-400",
                  )}
                >
                  {new Date(message.created_at).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))}
          {(messages ?? []).length === 0 && (
            <p className="py-8 text-center text-sm text-slate-400">No messages in this conversation.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
