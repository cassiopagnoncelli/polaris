import { Tracker } from "./tracker";

export default function HomePage() {
  return (
    <>
      <h1>Browser events through your own origin</h1>
      <p className="muted">
        The Web SDK is configured with <code>endpoint: &quot;/api/polaris/events&quot;</code>. That
        route — <code>app/api/polaris/events/route.ts</code> — attaches the real API key and
        forwards the batch to the ingester, then returns the ingester&apos;s per-event answer
        unchanged.
      </p>

      <Tracker />

      <h2>Pick this when</h2>
      <ul>
        <li>a publishable key in the bundle is not acceptable to your security review</li>
        <li>you would rather not maintain an origin allow-list row per environment</li>
        <li>third-party analytics hosts are blocked for a meaningful slice of your traffic</li>
        <li>
          you want the server to decide <code>context.ip</code> and <code>context.user_agent</code>{" "}
          rather than believing the client
        </li>
      </ul>

      <h2>Pick sample 01 instead when</h2>
      <ul>
        <li>you do not want your app servers in the path of event traffic</li>
        <li>
          the origin allow-list and per-key rate limits are the controls you actually want, applied
          by the platform rather than reimplemented here
        </li>
        <li>your site is static or edge-cached and has no server to relay through</li>
      </ul>

      <h2>Before shipping this</h2>
      <ul>
        <li>rate limit the route — it is an unauthenticated write path into your key</li>
        <li>keep the batch size cap, and add a body size cap at your edge</li>
        <li>
          do not log request bodies: events carry identifiers, and this route sees all of them
        </li>
      </ul>
    </>
  );
}
