import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Subscription confirmed",
  robots: { index: false, follow: false },
};

export default function ConfirmedPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl md:text-4xl font-semibold">You&apos;re in.</h1>
      <p className="mt-3 text-gray-600">Subscription confirmed.</p>
      <p className="mt-2 text-gray-600">
        The next issue will arrive at the usual cadence. Unsubscribe link in every email.
      </p>
      <p className="mt-8 flex justify-center gap-6 text-sm">
        <Link href="/" className="underline underline-offset-2 hover:opacity-70">
          Back to the site
        </Link>
      </p>
    </div>
  );
}
