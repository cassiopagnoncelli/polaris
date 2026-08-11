import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polaris sample — relayed browser events",
  description: "Browser events relayed to the Polaris ingester through a first-party route.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <strong>Polaris sample</strong>
          <span className="muted">browser → your origin → ingester</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
