"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { record } from "../lib/feed";

/**
 * The nav, as a client component for two reasons.
 *
 * It marks the current route, which needs `usePathname()`. And it reports
 * each click into the activity feed *before* the route changes — so the
 * drawer shows the click and the `page.viewed` that follows it as two
 * separate lines. That ordering is the lesson: navigation is an interaction,
 * `page.viewed` is an event you chose to emit, and nothing in the SDK turns
 * the first into the second for you.
 */

interface NavLink {
  readonly href: string;
  readonly label: string;
  /** Query-string links exist to show that a search change is a new view. */
  readonly aside?: boolean;
}

const LINKS: readonly NavLink[] = [
  { href: "/", label: "Overview" },
  { href: "/checkout", label: "Checkout" },
  { href: "/transport", label: "Transport" },
  { href: "/learn", label: "Learn more" },
  { href: "/?utm_source=newsletter", label: "?utm_source=newsletter", aside: true },
];

export function SiteNav() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = search.length > 0 ? `${pathname}?${search}` : pathname;

  return (
    <nav className="topbar-nav">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={link.aside === true ? "nav-link nav-link-aside" : "nav-link"}
          aria-current={current === link.href ? "page" : undefined}
          onClick={() => record("ui", `click: nav → ${link.href}`)}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
