"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

import { useSession } from "@/lib/auth-client";
import { approveDeviceCode } from "@/lib/device-approve";

/**
 * The browser half of the device-authorization flow.
 *
 * A client that cannot take a password — the browser extension's "Sign
 * in with the web app", a CLI, a TV-style app — shows a short code; the
 * person approves it HERE, already signed in, in a real browser, and
 * the waiting client then fetches a session of its own.
 *
 * The code may arrive prefilled as `?user_code=`, so `useSearchParams`
 * needs a Suspense boundary to keep the page statically exportable.
 *
 * Note what this page is NOT: it is not how the extension is linked
 * when somebody is already signed in on the web. That path never
 * renders anything — the extension hands the page a code over the
 * bridge and the page approves it in the background
 * (`components/ExtensionBridge.tsx`).
 */
function DeviceApproval(): React.JSX.Element {
  const params = useSearchParams();
  const { data: session, isPending } = useSession();
  const [code, setCode] = React.useState(params.get("user_code") ?? "");
  const [state, setState] = React.useState<"idle" | "working" | "approved" | "failed">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  const approve = async (): Promise<void> => {
    setState("working");
    setMessage(null);
    const result = await approveDeviceCode(code);
    if (result.ok) {
      setState("approved");
      return;
    }
    setState("failed");
    setMessage(
      result.stage === "network"
        ? "Could not reach the server."
        : (result.error.error_description ??
            result.error.message ??
            "That code could not be approved. It may have expired."),
    );
  };

  if (isPending) return <p>Checking your session…</p>;
  if (!session?.user) {
    return <p>Sign in first, then open this page again to approve the code.</p>;
  }
  if (state === "approved") {
    return <p>Approved. You can close this tab — the app you started signs itself in.</p>;
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void approve();
      }}
    >
      <label htmlFor="user_code">Device code</label>
      <input
        id="user_code"
        name="user_code"
        value={code}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" disabled={state === "working" || code.trim() === ""}>
        {state === "working" ? "Approving…" : "Approve"}
      </button>
      {message !== null && <p role="alert">{message}</p>}
    </form>
  );
}

export default function DevicePage(): React.JSX.Element {
  return (
    <main>
      <h1>Approve a device</h1>
      <React.Suspense fallback={null}>
        <DeviceApproval />
      </React.Suspense>
    </main>
  );
}
