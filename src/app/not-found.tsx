import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center dark:bg-slate-950">
      <p className="text-sm font-semibold text-indigo-600">404</p>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Page not found</h1>
      <Link href="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">
        ← Back home
      </Link>
    </div>
  );
}
