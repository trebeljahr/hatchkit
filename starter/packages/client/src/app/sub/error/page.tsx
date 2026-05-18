import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Subscription link problem",
  robots: { index: false, follow: false },
};

const MESSAGES: Record<string, string> = {
  missing: "The confirmation link was missing its token. Try subscribing again.",
  malformed: "The confirmation link is malformed. Try subscribing again.",
  bad_signature: "The confirmation link is invalid. Try subscribing again.",
  expired: "This confirmation link has expired. Please resubscribe to get a fresh one.",
  list_add_failed:
    "Something went wrong on our end while adding you to the list. Please try again.",
};

export default async function ErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message =
    (reason && MESSAGES[reason]) ?? "We couldn't confirm your subscription. Please try again.";

  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl md:text-4xl font-semibold">Hmm.</h1>
      <p className="mt-4 text-gray-600">{message}</p>
      <p className="mt-8 flex justify-center gap-6 text-sm">
        <Link href="/sub" className="underline underline-offset-2 hover:opacity-70">
          Try again
        </Link>
        <Link href="/" className="underline underline-offset-2 hover:opacity-70">
          Back to the site
        </Link>
      </p>
    </div>
  );
}
