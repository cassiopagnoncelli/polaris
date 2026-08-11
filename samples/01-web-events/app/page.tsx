import { DemoPanel } from "./demo-panel";

export default function HomePage() {
  return (
    <>
      <h1>Browser events, straight to the ingester</h1>
      <p className="muted">
        This page holds one <code>@polaris/web-sdk</code> instance. It fires{" "}
        <code>page.viewed</code> on every navigation, batches events in IndexedDB, and POSTs them to{" "}
        <code>/v1/events</code> with a publishable API key.
      </p>

      <h2>What the SDK does for you</h2>
      <ul>
        <li>
          generates a UUIDv7 <code>event_id</code> and keeps it across retries, so a retried event
          deduplicates instead of double-counting
        </li>
        <li>
          persists <code>anonymous_id</code> and <code>session_id</code> in a first-party cookie,
          rotating the session after 30 minutes of inactivity
        </li>
        <li>
          queues and batches: eager flushes for the first 15 seconds, then every 5 seconds, plus a
          best-effort flush on page exit
        </li>
        <li>retries transient failures with exponential backoff and jitter</li>
      </ul>

      <h2>What it deliberately does not do</h2>
      <ul>
        <li>
          no autocapture — <code>page.viewed</code> is fired by{" "}
          <code>app/polaris-provider.tsx</code>, because a page view is your event with your schema
        </li>
        <li>no enrichment, attribution, or identity resolution — those are processors</li>
        <li>
          no catalog validation in the browser — the ingester is the authority and answers per event
        </li>
      </ul>

      <DemoPanel />
    </>
  );
}
