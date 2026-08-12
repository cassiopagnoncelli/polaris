import { ActivityFeed } from "../activity-feed";
import { IdentityPanel } from "../identity-panel";
import { BrowserCheckout } from "./browser-checkout";
import { RouteHandlerCheckout, ServerActionCheckout } from "./server-checkout";

export default function CheckoutPage() {
  return (
    <>
      <h1>One event, three producers</h1>
      <p className="muted">
        Navigating here already fired a second <code>page.viewed</code>. Everything below emits{" "}
        <code>checkout.started</code> v1, whose properties the ingester validates against{" "}
        <code>catalog/events/checkout/started.v1.yaml</code>. The three differ only in who sends
        them — and in <code>flow_variant</code>, which is how you tell them apart later.
      </p>

      <h2>From the browser</h2>
      <p className="muted">
        The Web SDK queues it with the tab&apos;s identity attached, and delivers it on the next
        flush. <code>flow_variant: &quot;browser&quot;</code>.
      </p>
      <div className="panel">
        <p>
          <strong>Cart</strong> — 1 × Polaris Mug (BRL 24.90), 2 × Sticker Pack (BRL 9.90)
        </p>
        <BrowserCheckout />
      </div>

      <h2>From the server</h2>
      <p className="muted">
        The Node SDK, holding a backend key that never reaches the browser, sending as the{" "}
        <code>payments-api</code> source. Both read the browser&apos;s <code>polaris_id</code>{" "}
        cookie and pass it as the event identity, so these land on the same visitor as the browser
        events above.
      </p>
      <div className="panel">
        <ServerActionCheckout />
      </div>
      <div className="panel">
        <RouteHandlerCheckout />
      </div>

      <h2>Why bother with a backend producer</h2>
      <ul>
        <li>
          money events must not depend on a browser staying open — a payment confirmed by your
          payment provider is a fact your server owns
        </li>
        <li>ad blockers and flaky mobile networks never touch this path</li>
        <li>
          the server can attach what the browser must not be trusted for: prices, entitlements, the
          resolved customer id
        </li>
      </ul>

      <h2>The three lifecycle rules for the Node SDK</h2>
      <ul>
        <li>
          <strong>One instance per process.</strong> <code>lib/polaris-node.ts</code> caches it on{" "}
          <code>globalThis</code> so a hot reload does not leak a queue and a timer per edit.
        </li>
        <li>
          <strong>Flush before you answer.</strong> <code>track()</code> only queues. Request-scoped
          runtimes freeze right after the response, so <code>await polaris.flush()</code> is what
          actually delivers.
        </li>
        <li>
          <strong>Close on shutdown.</strong> <code>autoFlushOnShutdown: true</code> drains on
          SIGTERM/SIGINT within <code>shutdownTimeoutMs</code>. The default in-memory queue does not
          survive a crash — for events you cannot lose, write your own outbox row first and emit
          from it.
        </li>
      </ul>

      <h2>Getting rejected on purpose</h2>
      <p className="muted">
        The second browser button sends the same event with a broken <code>currency</code>. The
        ingester answers <code>422</code> with a per-event <code>schema_validation_failed</code>,
        the SDK marks it permanent and drops it instead of retrying — watch the feed. Partial
        acceptance is the contract: one bad event never blocks the batch.
      </p>

      <div className="split">
        <div>
          <h2>Identity</h2>
          <IdentityPanel />
        </div>
        <div>
          <h2>Activity</h2>
          <ActivityFeed />
        </div>
      </div>
    </>
  );
}
