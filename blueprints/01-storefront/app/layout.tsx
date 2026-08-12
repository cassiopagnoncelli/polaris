import type { Metadata } from "next";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { ActivityDrawer } from "./activity-drawer";
import { PageViewTracker, PolarisProvider } from "./polaris-provider";
import { SiteNav } from "./site-nav";
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
          {/* useSearchParams() inside these needs a Suspense boundary. */}
          <Suspense fallback={null}>
            <PageViewTracker />
          </Suspense>
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              Polaris <span className="brand-dim">blueprint</span>
            </Link>
            <Suspense fallback={null}>
              <SiteNav />
            </Suspense>
          </header>
          <main>{children}</main>
          {/* One feed for the whole app, pinned to the bottom of every page. */}
          <ActivityDrawer />
        </PolarisProvider>
      </body>
    </html>
  );
}
