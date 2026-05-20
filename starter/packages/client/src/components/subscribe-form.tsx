"use client";

import { useState } from "react";

// Same regex as the server (services/newsletter/subscribe.ts) so client
// and server agree on what "looks like an email". The server is still
// authoritative — this is purely a UX layer that avoids a slow round-trip
// for obviously-malformed input.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && EMAIL_RE.test(trimmed);
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "already-subscribed" }
  | { kind: "error"; message: string };

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function SubscribeForm() {
  const [email, setEmail] = useState("");
  // Honeypot — wired but never shown. Bots that fill every input get
  // filtered server-side before any Listmonk call.
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [formatError, setFormatError] = useState<string | null>(null);

  function handleEmailChange(value: string) {
    setEmail(value);
    if (formatError !== null) setFormatError(null);
    if (status.kind === "error") setStatus({ kind: "idle" });
  }

  function handleEmailBlur() {
    if (email.trim().length === 0) {
      setFormatError(null);
      return;
    }
    setFormatError(looksLikeEmail(email) ? null : "That doesn't look like an email address.");
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "submitting") return;

    if (!looksLikeEmail(email)) {
      setFormatError("That doesn't look like an email address.");
      return;
    }
    setFormatError(null);
    setStatus({ kind: "submitting" });
    try {
      const res = await fetch(`${API_URL}/api/newsletter/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, website }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setStatus({
          kind: "error",
          message: data.message ?? "Something went wrong. Please try again.",
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { alreadySubscribed?: boolean };
      setStatus({ kind: data.alreadySubscribed ? "already-subscribed" : "success" });
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  if (status.kind === "success") {
    return (
      <div role="status" aria-live="polite" className="rounded-lg border p-5 text-sm">
        <p className="font-medium">Check your inbox.</p>
        <p className="mt-1 text-gray-600">
          Tap the confirmation link to finish. Spam folder is the usual suspect if it does not
          surface.
        </p>
      </div>
    );
  }

  if (status.kind === "already-subscribed") {
    return (
      <div role="status" aria-live="polite" className="rounded-lg border p-5 text-sm">
        <p className="font-medium">You are already on the list.</p>
        <p className="mt-1 text-gray-600">
          That address is already a confirmed subscriber. Nothing to do.
        </p>
      </div>
    );
  }

  const inlineErrorId = "newsletter-email-error";
  const visibleError = formatError ?? (status.kind === "error" ? status.message : null);

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <label htmlFor="newsletter-email" className="sr-only">
        Email address
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="newsletter-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => handleEmailChange(e.target.value)}
          onBlur={handleEmailBlur}
          disabled={status.kind === "submitting"}
          aria-invalid={visibleError !== null}
          aria-describedby={visibleError !== null ? inlineErrorId : undefined}
          className="h-11 flex-1 rounded-md border border-gray-300 px-3 text-base focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <button
          type="submit"
          disabled={status.kind === "submitting" || email.trim().length === 0}
          className="h-11 rounded-md bg-gray-900 px-5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto"
        >
          {status.kind === "submitting" ? "Sending…" : "Subscribe"}
        </button>
      </div>

      {/* Honeypot — visually hidden, aria-hidden, tab-skipped. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="newsletter-website">Website</label>
        <input
          id="newsletter-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {visibleError !== null && (
        <p id={inlineErrorId} role="alert" aria-live="assertive" className="text-sm text-red-700">
          {visibleError}
        </p>
      )}

      <p className="text-xs text-gray-500">
        One email at a regular cadence. Unsubscribe link in every issue.
      </p>
    </form>
  );
}
