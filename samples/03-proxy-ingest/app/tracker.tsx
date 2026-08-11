"use client";

import type { PolarisWebSdk } from "@polaris/web-sdk";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getPolaris } from "../lib/polaris";

interface LogLine {
  readonly id: number;
  readonly text: string;
}

export function Tracker() {
  const [sdk, setSdk] = useState<PolarisWebSdk | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const nextLineId = useRef(1);
  const pathname = usePathname();

  useEffect(() => {
    let active = true;
    void getPolaris().then((created) => {
      if (active) setSdk(created);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (sdk === null) return;
    void sdk.track(
      "page.viewed",
      {
        path: pathname,
        search: null,
        title: document.title,
        referrer: document.referrer.length > 0 ? document.referrer : null,
      },
      { schemaVersion: 2 },
    );
  }, [sdk, pathname]);

  return (
    <div className="panel">
      <div className="row">
        <button
          type="button"
          disabled={sdk === null}
          onClick={() => {
            void sdk?.flush().then((result) => {
              const line: LogLine = {
                id: nextLineId.current++,
                text: `flush -> delivered ${result.delivered}, queued ${result.queued}, dropped ${result.dropped}`,
              };
              setLog((previous) => [line, ...previous].slice(0, 10));
            });
          }}
        >
          flush now
        </button>
        <span className="muted">
          Open the Network tab: every request goes to <code>/api/polaris/events</code> on this
          origin.
        </span>
      </div>
      {log.length > 0 && (
        <ul className="feed">
          {log.map((line) => (
            <li key={line.id}>{line.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
