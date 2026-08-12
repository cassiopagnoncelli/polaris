import { ActivityFeed } from "../activity-feed";
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

      <h2>What actually differs</h2>
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

      <h2>Picking one</h2>
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

      <h2>Before shipping the relay</h2>
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

      <h2>Activity</h2>
      <ActivityFeed />
    </>
  );
}
