import Link from "next/link";
import { ActivityFeed } from "./activity-feed";
import { DemoPanel } from "./demo-panel";
import { IdentityPanel } from "./identity-panel";

export default function HomePage() {
  return (
    <>
      <h1>One storefront, three ways in</h1>
      <p className="muted">
        A single app that produces events from every surface Polaris supports, against one project,
        one catalog, and one visitor identity. The point is not any single path — it is that they
        agree with each other.
      </p>

      <table className="compare">
        <thead>
          <tr>
            <th>Path</th>
            <th>SDK</th>
            <th>Key</th>
            <th>Source</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>browser → ingester</td>
            <td>
              <code>@polaris/web-sdk</code>
            </td>
            <td>web, in the bundle</td>
            <td>
              <code>storefront-web</code>
            </td>
            <td>
              <Link href="/transport">/transport</Link>
            </td>
          </tr>
          <tr>
            <td>browser → this origin → ingester</td>
            <td>
              <code>@polaris/web-sdk</code>
            </td>
            <td>web, server-side</td>
            <td>
              <code>storefront-web</code>
            </td>
            <td>
              <Link href="/transport">/transport</Link>
            </td>
          </tr>
          <tr>
            <td>server → ingester</td>
            <td>
              <code>@polaris/node-sdk</code>
            </td>
            <td>backend, server-side</td>
            <td>
              <code>payments-api</code>
            </td>
            <td>
              <Link href="/checkout">/checkout</Link>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>The thing worth seeing</h2>
      <p className="muted">
        The browser writes its identity into a first-party <code>polaris_id</code> cookie. The
        server reads that cookie and hands the same <code>anonymous_id</code> to its own events. So
        a <code>page.viewed</code> from this tab and a <code>checkout.started</code> from a Server
        Action arrive already joined — no identity resolution, no stitching job, no guessing.{" "}
        <Link href="/checkout">/checkout</Link> shows both sides and tells you whether they matched.
      </p>

      <div className="split">
        <div>
          <h2>Identity</h2>
          <IdentityPanel />
          <h2>Controls</h2>
          <DemoPanel />
        </div>
        <div>
          <h2>Activity</h2>
          <ActivityFeed />
        </div>
      </div>

      <h2>What the Web SDK does for you</h2>
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
    </>
  );
}
