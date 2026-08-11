import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polaris sample — server events",
  description: "Backend events sent to the Polaris ingester with @polaris/node-sdk.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <strong>Polaris sample</strong>
          <span className="muted">server-side producer</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
