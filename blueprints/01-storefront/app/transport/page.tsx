import Link from "next/link";
import { TransportSwitch } from "./transport-switch";

export default function TransportPage() {
  return (
    <>
      <h1>Two ways to the ingester</h1>
      <p className="muted">
        The Web SDK does not care where it posts. Point it at the ingester and it is a direct
        producer; point it at a route on your own origin and that route becomes a relay. Same SDK,
        same events, same identity — different trust boundary.
      </p>

      <TransportSwitch />

      <h2>What to watch while you switch</h2>
      <ul>
        <li>
          <strong>The Network tab.</strong> Direct mode posts cross-origin to the ingester with{" "}
          <code>x-polaris-api-key</code> visible in the request; relay mode posts same-origin to
          this app, and the key is nowhere in the browser.
        </li>
        <li>
          <strong>The identity panel</strong> on the <Link href="/">overview</Link>.{" "}
          <code>anonymous_id</code> does not change. Identity is in the first-party cookie, not in
          the SDK instance, so replacing the instance does not touch the visitor.
        </li>
        <li>
          <strong>The activity drawer.</strong> The swap closes the old SDK, which drains
          best-effort; anything still queued at that point is gone.
        </li>
      </ul>

      <p className="muted">
        <Link href="/learn#transport">Learn more: direct vs relay</Link> — eight rows of trade-off,
        which one to pick, and what to do before you ship a relay route.
      </p>
    </>
  );
}
