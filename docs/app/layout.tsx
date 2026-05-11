import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://hatchkit.trebeljahr.com"),
  title: {
    default: "hatchkit",
    template: "%s · hatchkit",
  },
  description:
    "Interactive CLI for scaffolding full-stack TypeScript projects with composable GPU-backed ML services — on infrastructure you own.",
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
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
