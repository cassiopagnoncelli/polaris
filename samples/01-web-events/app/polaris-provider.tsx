"use client";

import type { PolarisWebSdk } from "@polaris/web-sdk";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { getPolaris } from "../lib/polaris";

const PolarisContext = createContext<PolarisWebSdk | null>(null);

/**
 * Returns the SDK once it has finished probing storage, `null` before that.
 * Callers must handle `null`: the first render of any page happens before
 * the SDK exists (and on the server, where it never exists).
 */
export function usePolaris(): PolarisWebSdk | null {
  return useContext(PolarisContext);
}

export function PolarisProvider({ children }: { children: ReactNode }) {
  const [sdk, setSdk] = useState<PolarisWebSdk | null>(null);

  useEffect(() => {
    let active = true;
    void getPolaris().then((created) => {
      if (active) setSdk(created);
    });
    return () => {
      active = false;
    };
    // The instance is a module-level singleton, so it deliberately outlives
    // this component: no `close()` on unmount. React's StrictMode double
    // mount in development would otherwise tear down a live queue.
  }, []);

  return <PolarisContext.Provider value={sdk}>{children}</PolarisContext.Provider>;
}

/**
 * Polaris has no auto page tracking — by design. `page.viewed` is an event
 * you own, with a schema in the catalog, so the app decides when a "page
 * view" happened. In the App Router that means firing it when the pathname
 * or the query string changes.
 *
 * `useSearchParams()` needs a Suspense boundary above it (see layout.tsx),
 * otherwise the whole route opts out of static rendering.
 */
export function PageViewTracker() {
  const sdk = usePolaris();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    if (sdk === null) return;
    void sdk.track(
      "page.viewed",
      {
        // page.viewed v2 properties. Every key is required by the catalog
        // schema; unknown values are explicit nulls, never omitted.
        path: pathname,
        search: search.length > 0 ? `?${search}` : null,
        title: document.title,
        referrer: document.referrer.length > 0 ? document.referrer : null,
      },
      {
        // The SDK defaults to schema_version 1. page.viewed v1 is a
        // different shape, so v2 callers say so explicitly.
        schemaVersion: 2,
        context: {
          page: {
            url: window.location.href,
            path: pathname,
            title: document.title,
            referrer: document.referrer.length > 0 ? document.referrer : null,
          },
          locale: navigator.language,
        },
      },
    );
  }, [sdk, pathname, search]);

  return null;
}
