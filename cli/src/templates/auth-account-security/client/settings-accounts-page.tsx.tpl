"use client";

/**
 * Settings → Sign-in methods. Written by hatchkit's `auth-account-security`
 * feature; yours to edit from here on.
 */

import Link from "next/link";
import type * as React from "react";
import { LinkedAccounts } from "@/components/settings/linked-accounts";
__HATCHKIT_ACCOUNTS_IMPORTS__

export default function SignInMethodsPage(): React.JSX.Element {
  return (
    <div className="space-y-8">
      <div>
        <Link href="/settings" className="text-sm text-muted-foreground hover:underline">
          ← Settings
        </Link>
        <h1 className="text-2xl font-bold">Sign-in methods</h1>
        <p className="text-muted-foreground">Link another way to sign in, or remove one.</p>
      </div>
      <div className="max-w-md space-y-8">
        <LinkedAccounts />
__HATCHKIT_ACCOUNTS_SECTIONS__
      </div>
    </div>
  );
}
