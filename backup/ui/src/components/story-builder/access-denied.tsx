"use client";

import Link from "next/link";
import { ShieldX } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface AccessDeniedProps {
  /** Human-readable name of the required role (e.g. "Generate HLD Documents"). */
  roleName?: string;
  /** Extra message shown below the main text. */
  message?: string;
}

/**
 * Full-page access-denied banner.
 *
 * Drop this into any page where the user lacks the required role.
 * It gives a clear explanation and a link back home.
 */
export function AccessDenied({ roleName, message }: AccessDeniedProps) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md w-full border-red-900/40 bg-slate-900/80">
        <CardContent className="flex flex-col items-center gap-4 py-10 px-6 text-center">
          <div className="rounded-full bg-red-500/10 p-4">
            <ShieldX className="h-10 w-10 text-red-400" />
          </div>

          <h2 className="text-xl font-semibold text-slate-100">Access Denied</h2>

          <p className="text-sm text-slate-400">
            You do not have the required permissions to access this page.
            {roleName && (
              <>
                {" "}The <span className="font-medium text-slate-300">&ldquo;{roleName}&rdquo;</span> role is required.
              </>
            )}
          </p>

          {message && (
            <p className="text-xs text-slate-500">{message}</p>
          )}

          <p className="text-xs text-slate-500">
            Contact your administrator to have the appropriate roles assigned to your account.
          </p>

          <Link href="/">
            <Button variant="outline" className="mt-2">
              Go to Home
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
