import type { Metadata } from "next";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { PageViewTracker, PolarisProvider } from "./polaris-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polaris sample — browser events",
  description: "Browser events sent to the Polaris ingester with @polaris/web-sdk.",
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
            <strong>Polaris sample</strong>
            <nav>
              <Link href="/">Home</Link>
              <Link href="/checkout">Checkout</Link>
              <Link href="/?utm_source=newsletter">Home ?utm_source=newsletter</Link>
            </nav>
          </header>
          <main>{children}</main>
        </PolarisProvider>
      </body>
    </html>
  );
}
