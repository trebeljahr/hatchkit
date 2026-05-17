import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import type { ReactNode } from "react";
import { DEFAULT_SOCIAL_IMAGE, DEFAULT_TWITTER_IMAGE, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/seo";

const inter = Inter({ subsets: ["latin"] });
// Plausible loader is opt-in: forks set both env vars (typically in
// `.env.production`) to point at their own analytics endpoint. Leaving
// either unset disables the loader entirely so the public docs site —
// and any fork that hasn't wired up analytics — never beacons to a
// stranger's Plausible instance.
const plausibleDomain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? "";
const plausibleScriptUrl = process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL ?? "";
const plausibleEnabled = plausibleDomain.length > 0 && plausibleScriptUrl.length > 0;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    images: [
      {
        url: DEFAULT_SOCIAL_IMAGE,
        width: 1200,
        height: 630,
        alt: "hatchkit documentation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [DEFAULT_TWITTER_IMAGE],
  },
  icons: {
    icon: [
      { url: "/img/favicon.ico" },
      { url: "/img/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/img/apple-touch-icon.png",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        {plausibleEnabled ? (
          <Script id="plausible-loader" strategy="afterInteractive">
            {`
              (function () {
                var domain = ${JSON.stringify(plausibleDomain)};
                if (location.hostname !== domain) return;
                window.plausible = window.plausible || function() {
                  (window.plausible.q = window.plausible.q || []).push(arguments);
                };
                var script = document.createElement("script");
                script.defer = true;
                script.dataset.domain = domain;
                script.src = ${JSON.stringify(plausibleScriptUrl)};
                document.head.appendChild(script);
              })();
            `}
          </Script>
        ) : null}
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
