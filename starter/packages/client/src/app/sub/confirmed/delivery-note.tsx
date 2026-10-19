"use client";

import { useSearchParams } from "next/navigation";

// `delivery` is set by the confirm route when the signup asked for a
// lead magnet: `sent` once the download email is queued, `failed` when
// it could not be sent. Read on the client for the same reason as the
// error page's reason (see sub/error/reason-message.tsx): the route has
// to stay statically renderable, so keep this inside <Suspense>.
const MESSAGES: Record<string, string> = {
  sent: "We emailed you the download link.",
  failed:
    "We could not send the download email. Enter your address in the signup form again and we will send it.",
};

export function DeliveryNote() {
  const delivery = useSearchParams().get("delivery");
  const message = delivery ? MESSAGES[delivery] : undefined;
  if (!message) return null;
  return <p className="mt-2 text-gray-600">{message}</p>;
}
