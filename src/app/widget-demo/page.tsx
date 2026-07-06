import type { Metadata } from "next";
import Script from "next/script";

export const metadata: Metadata = {
  title: "Widget demo — AI Receptionist",
  robots: { index: false },
};

/**
 * A plain page that embeds the widget exactly the way a customer's website
 * would — used from the dashboard's install page for end-to-end testing.
 */
export default async function WidgetDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  const { key } = await searchParams;

  return (
    <div className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-bold text-slate-900">Acme Example Co.</h1>
      <p className="mt-4 leading-relaxed text-slate-600">
        This page simulates a customer&apos;s website with the AI Receptionist widget installed.
        Look for the launcher in the corner — click it and start chatting, or use the microphone
        button for a voice conversation.
      </p>
      <p className="mt-4 leading-relaxed text-slate-600">
        Everything on this page is plain content; the widget below is loaded with the same script
        tag your customers would paste into their sites.
      </p>

      {key ? (
        <Script src="/widget.js" data-key={key} strategy="afterInteractive" />
      ) : (
        <p className="mt-8 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Missing <code>?key=</code> parameter — open this page from your dashboard&apos;s install
          section.
        </p>
      )}
    </div>
  );
}
