"use client";

/**
 * /admin — model, team and budget administration.
 *
 * Client-side gating only. This is a convenience so a non-admin doesn't get a
 * broken-looking page of empty tables, NOT a security boundary: every
 * /api/admin/* route re-checks the JWT role server-side (router/auth.py
 * `get_current_admin`). Hiding a link has never stopped anyone from typing a
 * URL, so the check that matters lives at the API.
 */

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Cpu, Gauge, ShieldAlert, Users, BarChart3 } from "lucide-react";

import { getUser } from "@/lib/auth";

/** The user's admin flag, read from the token in localStorage.
 *
 *  `useSyncExternalStore` rather than an effect: the value lives outside React
 *  and localStorage doesn't exist during the server render. The server
 *  snapshot is `null` (= "not known yet"), which renders nothing, so the
 *  server and first client render agree and there is no hydration mismatch.
 *  Nothing here subscribes because a login/logout navigates the whole app. */
const NO_SUBSCRIBE = () => () => {};
const readIsAdmin = (): boolean | null => {
  const user = getUser();
  return !!user && (user.is_admin || user.role === "admin");
};
const serverIsAdmin = (): boolean | null => null;

const TABS = [
  { href: "/admin/models", label: "Models", Icon: Cpu },
  { href: "/admin/teams", label: "Teams", Icon: Users },
  { href: "/admin/quotas", label: "Budgets", Icon: Gauge },
  { href: "/admin/usage", label: "Usage", Icon: BarChart3 },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = useSyncExternalStore(NO_SUBSCRIBE, readIsAdmin, serverIsAdmin);

  if (isAdmin === null) return null;

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
        <ShieldAlert className="h-8 w-8 text-amber-400" />
        <h1 className="text-lg font-semibold text-slate-100">Administrator access required</h1>
        <p className="max-w-md text-sm text-slate-400">
          Model catalogues, teams and token budgets are managed by administrators.
        </p>
        <button
          type="button"
          onClick={() => router.push("/usage")}
          className="mt-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
        >
          View my own usage
        </button>
      </div>
    );
  }

  return (
    <div className="p-6">
      <nav className="mb-6 flex gap-1 border-b border-slate-800">
        {TABS.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                active
                  ? "border-violet-500 text-violet-300"
                  : "border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-100"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
