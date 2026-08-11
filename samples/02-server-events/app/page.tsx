import { CheckoutFetchButton, CheckoutForm } from "./checkout-form";

export default function HomePage() {
  return (
    <>
      <h1>Backend events, from the server only</h1>
      <p className="muted">
        The API key here is <code>POLARIS_API_KEY</code> — no <code>NEXT_PUBLIC_</code> prefix, so
        it never reaches the browser. Both buttons emit <code>checkout.started</code>; one goes
        through a Server Action, the other through a route handler.
      </p>

      <div className="panel">
        <CheckoutForm />
      </div>
      <div className="panel">
        <CheckoutFetchButton />
      </div>
      <p className="muted">
        Watch the terminal running <code>pnpm dev</code>: the SDK&apos;s <code>onFlush</code>{" "}
        callback logs what each flush delivered.
      </p>

      <h2>Why a backend producer at all</h2>
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

      <h2>The three lifecycle rules</h2>
      <ul>
        <li>
          <strong>One instance per process.</strong> <code>lib/polaris.ts</code> caches it on{" "}
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
    </>
  );
}
