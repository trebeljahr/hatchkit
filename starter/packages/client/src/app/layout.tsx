import type { Metadata, Viewport } from "next";
import { TRPCProvider } from "@/providers/trpc-provider";
import { AuthProvider } from "@/providers/auth-provider";
import { MobileBridgeLoader } from "@/mobile/MobileBridgeLoader";
import { ROOT_MARKER_SCRIPT } from "@/mobile/platform";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: {
    default: "My App",
    template: "%s | My App",
  },
  description: "A full-stack web application",
};

/*
 * `viewport-fit=cover` ships to EVERY host, web included.
 *
 * One static export serves the browser, the installed web app and both
 * native shells, and this export is static — so there is no build in
 * which the meta tag can be left out for web. A normal mobile browser
 * applies no insets, so it is harmless there. An INSTALLED web app gets
 * the real insets with none of styles/native.css applying to it, and
 * content runs under the notch. styles/standalone.css is the answer, and
 * is a separate file from native.css precisely because it is not inert by
 * construction.
 *
 * Note what is deliberately absent: `maximumScale: 1` / `userScalable:
 * false`. Stopping iOS from zooming a focused field by taking zoom away
 * from everyone is not a trade worth making — native.css sets 16px fields
 * under the root marker instead.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/*
          The native root marker, set PRE-PAINT.

          It is set twice on purpose: here, before the first paint, and
          again by mobile/bridge.ts once its dynamic imports resolve. The
          pre-paint one is what matters on a WebView reload, which has no
          splash screen to hide the unpadded frame.

          The marker goes on <html>, never <body>, and that is a
          correctness decision rather than a style one. A pre-paint script
          that mutates <body> makes the served HTML and the hydrated DOM
          disagree about body's attributes, and the only way to silence
          that is `suppressHydrationWarning` on <body> — which then
          silences every OTHER body-level mismatch, for the web app,
          forever. It is also why this can sit in <head>:
          `document.documentElement` exists during head parsing,
          `document.body` does not.
        */}
        <script dangerouslySetInnerHTML={{ __html: ROOT_MARKER_SCRIPT }} />
        {process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN && (
          <script
            defer
            data-domain={process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN}
            src={
              process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL ||
              "https://plausible.io/js/script.js"
            }
          />
        )}
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <MobileBridgeLoader />
        <TRPCProvider>
          <AuthProvider>{children}</AuthProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
