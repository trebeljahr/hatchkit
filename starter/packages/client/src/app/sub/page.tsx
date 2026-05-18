import type { Metadata } from "next";
import { SubscribeForm } from "@/components/subscribe-form";

export const metadata: Metadata = {
  title: "Subscribe",
  description: "Sign up for the newsletter.",
  alternates: { canonical: "/sub" },
  robots: { index: false, follow: false },
};

export default function SubscribePage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-16">
      <header className="mb-8">
        <h1 className="text-3xl md:text-4xl font-semibold">Subscribe</h1>
        <p className="mt-3 text-gray-600">
          Drop your email below. We'll send a confirmation link to verify the address — no list
          membership is created until you click it.
        </p>
      </header>

      <section>
        <div className="rounded-lg border p-5 md:p-6">
          <SubscribeForm />
        </div>
      </section>
    </div>
  );
}
