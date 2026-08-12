"use client";

import type { PolarisWebSdk } from "@polaris/web-sdk";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { record } from "../lib/feed";
import { getPolaris } from "../lib/polaris-web";
import { readTransportMode, type TransportMode, writeTransportMode } from "../lib/transport-mode";

interface PolarisContextValue {
  /** The SDK, or null before it exists and while a transport swap is in flight. */
  readonly sdk: PolarisWebSdk | null;
  /** Null until the stored preference has been read on the client. */
  readonly mode: TransportMode | null;
  readonly setMode: (mode: TransportMode) => void;
}

const PolarisContext = createContext<PolarisContextValue>({
  sdk: null,
  mode: null,
  setMode: () => undefined,
});

/**
 * Callers must handle `sdk === null`: the first render of any page happens
 * before the SDK exists, on the server it never exists, and it drops back to
 * null for the moment a transport swap takes.
 */
export function usePolaris(): PolarisContextValue {
  return useContext(PolarisContext);
}

export function PolarisProvider({ children }: { children: ReactNode }) {
  const [sdk, setSdk] = useState<PolarisWebSdk | null>(null);
  const [mode, setModeState] = useState<TransportMode | null>(null);

  // Resolve the stored preference after mount, never during render: the
  // server has no localStorage, so reading it inline would render one thing
  // on the server and another on the client and fail hydration.
  useEffect(() => {
    setModeState(readTransportMode());
  }, []);

  useEffect(() => {
    if (mode === null) return;
    let active = true;
    // Drop the old instance from the tree before the swap resolves, so no
    // button can call `track()` on an SDK that is being closed.
    setSdk(null);
    void getPolaris(mode).then((created) => {
      if (active) setSdk(created);
    });
    return () => {
      active = false;
    };
    // No `close()` on unmount. The instance is a module-level singleton that
    // deliberately outlives this component — React's StrictMode double mount
    // in development would otherwise tear down a live queue.
  }, [mode]);

  const setMode = useCallback((next: TransportMode) => {
    writeTransportMode(next);
    setModeState(next);
  }, []);

  return (
    <PolarisContext.Provider value={{ sdk, mode, setMode }}>{children}</PolarisContext.Provider>
  );
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
  const { sdk } = usePolaris();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    if (sdk === null) return;
    const url = search.length > 0 ? `${pathname}?${search}` : pathname;
    record("ui", `route change → ${url}`);
    void sdk
      .track(
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
      )
      // Queued, not delivered — the id is how you find it again in the
      // flush line that follows, and in `raw.events` after that.
      .then((eventId) => record("web", `track page.viewed v2 ${url} -> ${eventId}`));
  }, [sdk, pathname, search]);

  return null;
}
