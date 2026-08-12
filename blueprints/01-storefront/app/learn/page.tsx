import Link from "next/link";

/**
 * The reading. The other three pages are for pressing buttons; everything
 * they used to explain in place lives here, so a page you are interacting
 * with is not also a page you are reading.
 */

const TOPICS = [
  { href: "#stitch", label: "The identity stitch" },
  { href: "#catalog", label: "The catalog is the authority" },
  { href: "#web-sdk", label: "What the Web SDK does" },
  { href: "#transport", label: "Direct vs relay" },
  { href: "#backend", label: "Backend producers" },
  { href: "#left-to-you", label: "Left to you" },
] as const;

export default function LearnPage() {
  return (
    <>
      <h1>Learn more</h1>
      <p className="muted">
        What this blueprint is actually demonstrating, in one place. Every section here has a page
        you can go press the buttons on.
      </p>

      <nav className="toc" aria-label="On this page">
        {TOPICS.map((topic) => (
          <a key={topic.href} href={topic.href}>
            {topic.label}
          </a>
        ))}
      </nav>

      <h2 id="stitch">The identity stitch</h2>
      <p>
        The browser writes its identity into a first-party <code>polaris_id</code> cookie. The
        server reads that cookie and hands the same <code>anonymous_id</code> to its own events. So
        a <code>page.viewed</code> from a tab and a <code>checkout.started</code> from a Server
        Action arrive already joined — no identity resolution, no stitching job, no guessing.
      </p>
      <p className="muted">
        The fragile part is <em>where</em> the identity is stored. The cookie is only the SDK&apos;s
        preferred layer; if it is unavailable the SDK falls back to <code>localStorage</code>,{" "}
        <code>sessionStorage</code>, then memory. Those are invisible to the server, so the stitch
        stops working with no error anywhere — the browser keeps tracking happily and the backend
        events quietly land on a different visitor. The <code>storage layer</code> line on the{" "}
        <Link href="/">overview</Link> is how you find that out.
      </p>
      <p className="muted">
        <Link href="/checkout">/checkout</Link> shows both sides and tells you whether they matched.
      </p>

      <h2 id="catalog">The catalog is the authority</h2>
      <p>
        The SDK holds no catalog and validates nothing — it queues whatever you hand it. The
        ingester owns the schemas and answers per event, which means a wrong name, a retired
        version, or a bad property all leave the browser looking exactly like a good event and come
        back refused.
      </p>
      <table className="compare">
        <thead>
          <tr>
            <th>Reason code</th>
            <th>Means</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>invalid_properties</code>
            </td>
            <td>
              the shape did not match the declared <code>schema_version</code> — a{" "}
              <code>currency</code> of <code>&quot;brazilian real&quot;</code> where ISO 4217 was
              required
            </td>
          </tr>
          <tr>
            <td>
              <code>schema_version_sunset</code>
            </td>
            <td>
              the version is registered and the properties fit, but it is past its{" "}
              <code>sunset_at</code>. A migration deadline, from the producer&apos;s side
            </td>
          </tr>
          <tr>
            <td>
              <code>unknown_event</code>
            </td>
            <td>
              nothing registers that name. Adding an event is a catalog change, not a client change
            </td>
          </tr>
          <tr>
            <td>
              <code>unsupported_schema_version</code>
            </td>
            <td>the name is known, that version of it is not</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        Partial acceptance is the contract: one bad event never blocks the batch. Rejections come
        back marked permanent, so the SDK drops them instead of retrying — the activity drawer shows{" "}
        <code>drop … permanent_failure</code> a flush later. <code>onDrop</code> is deliberately
        coarse; the reason code itself is in the response body, in the Network tab.
      </p>
      <p className="muted">
        The <Link href="/">overview</Link> has a button for each of the last two, and{" "}
        <Link href="/checkout">/checkout</Link> has one for the first.
      </p>

      <h2 id="web-sdk">What the Web SDK does, and what it refuses to</h2>
      <div className="cards cards-2">
        <article className="card">
          <h3>Does for you</h3>
          <ul>
            <li>
              generates a UUIDv7 <code>event_id</code> and keeps it across retries, so a retried
              event deduplicates instead of double-counting
            </li>
            <li>
              persists <code>anonymous_id</code> and <code>session_id</code> in a first-party
              cookie, rotating the session after 30 minutes of inactivity
            </li>
            <li>
              queues and batches: eager flushes for the first 15 seconds, then every 5 seconds, plus
              a best-effort flush on page exit
            </li>
            <li>retries transient failures with exponential backoff and jitter</li>
          </ul>
        </article>
        <article className="card">
          <h3>Deliberately does not</h3>
          <ul>
            <li>
              no autocapture — <code>page.viewed</code> is fired by{" "}
              <code>app/polaris-provider.tsx</code>, because a page view is your event with your
              schema
            </li>
            <li>no enrichment, attribution, or identity resolution — those are processors</li>
            <li>
              no catalog validation in the browser — the ingester is the authority and answers per
              event
            </li>
          </ul>
        </article>
      </div>
      <p className="muted">
        The absence of autocapture is why the activity drawer tags interactions{" "}
        <span className="tag tag-ui">ui</span> and events <span className="tag tag-web">web</span>{" "}
        separately. The gap between those two lines is where a <code>track()</code> call has to go
        in your own app, because nothing in the SDK puts it there for you.
      </p>

      <h2 id="transport">Direct vs relay</h2>
      <p>
        The Web SDK does not care where it posts. Point it at the ingester and it is a direct
        producer; point it at a route on your own origin and that route becomes a relay. Same SDK,
        same events, same identity — different trust boundary.{" "}
        <Link href="/transport">/transport</Link> switches between them in place.
      </p>
      <table className="compare">
        <thead>
          <tr>
            <th>&nbsp;</th>
            <th>direct</th>
            <th>relay</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>API key</td>
            <td>publishable, in the JS bundle</td>
            <td>never leaves your server</td>
          </tr>
          <tr>
            <td>Origin allow-list</td>
            <td>required, one row per environment</td>
            <td>not consulted — no browser Origin reaches the ingester</td>
          </tr>
          <tr>
            <td>CORS preflight</td>
            <td>one per batch, cross-origin</td>
            <td>none, same-origin</td>
          </tr>
          <tr>
            <td>
              <code>context.ip</code> / <code>user_agent</code>
            </td>
            <td>whatever the client claims</td>
            <td>stamped from the connection by the relay</td>
          </tr>
          <tr>
            <td>Page-exit flush</td>
            <td>
              <code>fetch(keepalive)</code> — beacons cannot set the key header
            </td>
            <td>
              <code>sendBeacon</code> works, nothing to authenticate client-side
            </td>
          </tr>
          <tr>
            <td>Content blockers</td>
            <td>a separate analytics host is an easy match</td>
            <td>first-party path, treated differently</td>
          </tr>
          <tr>
            <td>Who carries the traffic</td>
            <td>the platform</td>
            <td>your app servers, at your cost and your uptime</td>
          </tr>
          <tr>
            <td>Rate limiting</td>
            <td>per key, by the ingester</td>
            <td>yours to add — the route is an unauthenticated write path</td>
          </tr>
        </tbody>
      </table>

      <h3>Picking one</h3>
      <p className="muted">
        Choose <strong>direct</strong> when you do not want your app servers in the path of event
        traffic, when the allow-list and per-key limits are the controls you actually want applied
        by the platform rather than reimplemented, or when the site is static or edge-cached and has
        no server to relay through.
      </p>
      <p className="muted">
        Choose <strong>relay</strong> when a publishable key in the bundle will not survive security
        review, when you would rather not maintain an allow-list row per environment, when blocked
        third-party hosts cost you a meaningful slice of traffic, or when you want the server to
        decide <code>context.ip</code> rather than believing the client.
      </p>

      <h3>Before shipping the relay</h3>
      <ul>
        <li>rate limit the route — it is an unauthenticated write path into your key</li>
        <li>keep the batch size cap, and add a body size cap at your edge</li>
        <li>
          do not log request bodies: events carry identifiers, and this route sees all of them
        </li>
        <li>
          delete the mode you did not pick, along with the switch. Shipping both is a blueprint
          affordance, not an architecture.
        </li>
      </ul>
      <p className="muted">
        Switching transport mid-session drops whatever is still queued: the swap closes the old SDK,
        which flushes best-effort and then tears down its queue. That is the honest cost, and the
        reason a real app picks one at build time.
      </p>

      <h2 id="backend">Backend producers</h2>
      <p>
        The Node SDK holds a backend key that never reaches the browser and sends as a different
        catalog source. It reads the browser&apos;s <code>polaris_id</code> cookie and passes it as
        the event identity, so its events land on the same visitor as the browser&apos;s.{" "}
        <Link href="/checkout">/checkout</Link> emits the same <code>checkout.started</code> from a
        Server Action and a route handler alongside the browser&apos;s.
      </p>

      <h3>Why bother with a backend producer</h3>
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

      <h3>The three lifecycle rules for the Node SDK</h3>
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

      <h2 id="left-to-you">Left to you</h2>
      <ul>
        <li>
          consent gating — Polaris carries <code>consent</code> metadata on the envelope but
          enforces nothing in v1
        </li>
        <li>deciding what a page view means in your app</li>
        <li>forwarding the diagnostic callbacks to your own logging or metrics</li>
        <li>a real origin allow-list per environment, if you keep the direct path</li>
        <li>picking one transport and deleting the other, along with the switch</li>
      </ul>
    </>
  );
}
