import type { Metadata } from "next";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { PageViewTracker, PolarisProvider } from "./polaris-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polaris blueprint — storefront",
  description:
    "Browser, relayed, and backend events reaching the Polaris ingester from one Next.js app.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PolarisProvider>
          {/* useSearchParams() inside the tracker needs a Suspense boundary. */}
          <Suspense fallback={null}>
            <PageViewTracker />
          </Suspense>
          <header className="topbar">
            <strong>Polaris blueprint</strong>
            <nav>
              <Link href="/">Overview</Link>
              <Link href="/checkout">Checkout</Link>
              <Link href="/transport">Transport</Link>
              <Link href="/?utm_source=newsletter">Overview ?utm_source=newsletter</Link>
            </nav>
          </header>
          <main>{children}</main>
        </PolarisProvider>
      </body>
    </html>
  );
}
