import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import type { ReactNode } from "react";

const inter = Inter({ subsets: ["latin"] });
const plausibleDomain = "hatchkit.trebeljahr.com";
const plausibleScriptUrl =
  "https://plausible.trebeljahr.com/js/script.file-downloads.hash.outbound-links.pageview-props.revenue.tagged-events.js";

export const metadata: Metadata = {
  metadataBase: new URL("https://hatchkit.trebeljahr.com"),
  title: {
    default: "hatchkit",
    template: "%s · hatchkit",
  },
  description:
    "Interactive CLI for scaffolding full-stack TypeScript projects with composable GPU-backed ML services — on infrastructure you own.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "https://hatchkit.trebeljahr.com",
    title: "hatchkit",
    description:
      "From `npx hatchkit` to a deployed full-stack app on infrastructure you own — including GPU-backed ML services.",
    images: ["/img/social-card.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "hatchkit",
    description:
      "From `npx hatchkit` to a deployed full-stack app on infrastructure you own — including GPU-backed ML services.",
    images: ["/img/social-card.png"],
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
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
