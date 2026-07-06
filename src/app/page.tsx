import Link from "next/link";
import { Button } from "@/components/ui/button";

const FEATURES = [
  {
    title: "Answers from your knowledge",
    description:
      "Add FAQs and documents — your receptionist answers from them and honestly admits what it doesn't know.",
  },
  {
    title: "Voice conversations",
    description:
      "Visitors can talk naturally with their microphone. The receptionist listens and speaks back.",
  },
  {
    title: "Captures every lead",
    description:
      "Interested visitors are asked for their contact details conversationally — never with a form wall.",
  },
  {
    title: "One-line install",
    description: "A single script tag. No SDK, no build step, works on any website or CMS.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm text-white">
            AI
          </span>
          AI Receptionist
        </span>
        <nav className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            Sign in
          </Link>
          <Link href="/register">
            <Button size="sm">Get started</Button>
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-4xl px-6 pb-20 pt-24 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-6xl dark:text-white">
            A receptionist for your website that never sleeps
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600 dark:text-slate-300">
            Greet every visitor, answer their questions from your own knowledge base, and capture
            leads around the clock — by chat or voice. Installed with one script tag.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link href="/register">
              <Button>Create your receptionist</Button>
            </Link>
            <Link href="/login" className="text-sm font-semibold text-slate-900 dark:text-white">
              Sign in <span aria-hidden>→</span>
            </Link>
          </div>
          <pre className="mx-auto mt-14 w-fit max-w-full overflow-x-auto rounded-xl bg-slate-950 px-6 py-4 text-left text-sm text-emerald-300 shadow-lg">
            <code>{'<script src="https://yourapp.com/widget.js" data-key="…" async></script>'}</code>
          </pre>
        </section>

        <section className="border-t border-slate-100 bg-slate-50 py-20 dark:border-slate-900 dark:bg-slate-900/50">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <div key={feature.title}>
                <h3 className="font-semibold text-slate-900 dark:text-white">{feature.title}</h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-sm text-slate-400">
        © {new Date().getFullYear()} AI Receptionist
      </footer>
    </div>
  );
}
