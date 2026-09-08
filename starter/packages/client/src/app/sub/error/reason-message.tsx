"use client";

import { useSearchParams } from "next/navigation";

const MESSAGES: Record<string, string> = {
  missing: "The confirmation link was missing its token. Try subscribing again.",
  malformed: "The confirmation link is malformed. Try subscribing again.",
  bad_signature: "The confirmation link is invalid. Try subscribing again.",
  expired: "This confirmation link has expired. Please resubscribe to get a fresh one.",
  list_add_failed:
    "Something went wrong on our end while adding you to the list. Please try again.",
};

// Shown when there is no `reason` param, when it is not one we recognise, and
// as the Suspense fallback below — so the paragraph is never blank while the
// client boundary hydrates.
export const DEFAULT_MESSAGE = "We couldn't confirm your subscription. Please try again.";

export function ReasonParagraph({ message }: { message: string }) {
  return <p className="mt-4 text-gray-600">{message}</p>;
}

// The reason is read on the client instead of from server `searchParams` so
// this route stays statically renderable. `output: "export"` (desktop/mobile
// shells) cannot render a page that awaits `searchParams`, and there is no
// server work to do here anyway — the whole page is static copy plus a lookup
// in MESSAGES. The caller must keep this inside a <Suspense> boundary:
// otherwise useSearchParams opts the entire route into dynamic rendering,
// which is the same build failure by another route.
export function ReasonMessage() {
  const reason = useSearchParams().get("reason");
  const message = (reason ? MESSAGES[reason] : undefined) ?? DEFAULT_MESSAGE;

  return <ReasonParagraph message={message} />;
}
