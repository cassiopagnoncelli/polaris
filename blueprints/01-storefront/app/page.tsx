import Link from "next/link";
import { DemoPanel } from "./demo-panel";
import { EventPanel } from "./event-panel";
import { IdentityPanel } from "./identity-panel";

/** The three producer paths, as they appear in the catalog and in the code. */
const PATHS = [
  {
    title: "Direct",
    route: "browser → ingester",
    sdk: "@polaris/web-sdk",
    key: "web key, in the bundle",
    source: "storefront-web",
    href: "/transport",
    blurb:
      "The tab posts straight to the ingester. The key is publishable and origin-scoped; nothing of yours is in the path.",
  },
  {
    title: "Relayed",
    route: "browser → this origin → ingester",
    sdk: "@polaris/web-sdk",
    key: "web key, server-side",
    source: "storefront-web",
    href: "/transport",
    blurb:
      "Same SDK, pointed at a route on this origin that attaches the key. Nothing secret reaches the browser; your servers carry the traffic.",
  },
  {
    title: "Backend",
    route: "server → ingester",
    sdk: "@polaris/node-sdk",
    key: "backend key, server-side",
    source: "payments-api",
    href: "/checkout",
    blurb:
      "A Server Action and a route handler, holding a secret key, emitting the facts a browser must not be trusted for.",
  },
] as const;

/** The reading, one click away — see `app/learn/page.tsx`. */
const TOPICS = [
  {
    href: "/learn#stitch",
    title: "The identity stitch",
    blurb:
      "Why a browser event and a backend event arrive already joined, and the one setting that silently breaks it.",
  },
  {
    href: "/learn#catalog",
    title: "The catalog is the authority",
    blurb:
      "What the ingester refuses and why the browser cannot know first: the four reason codes, and partial acceptance.",
  },
  {
    href: "/learn#web-sdk",
    title: "What the Web SDK does",
    blurb:
      "Dedupe, identity, batching, backoff — and the three things it deliberately leaves to you.",
  },
  {
    href: "/learn#transport",
    title: "Direct vs relay",
    blurb:
      "Eight rows of trade-off, which one to pick, and what to do before you ship a relay route.",
  },
  {
    href: "/learn#backend",
    title: "Backend producers",
    blurb: "Why money events belong on the server, and the three lifecycle rules for the Node SDK.",
  },
  {
    href: "/learn#left-to-you",
    title: "Left to you",
    blurb:
      "Consent gating, deciding what a page view means in your app, and the other calls the blueprint deliberately does not make.",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Blueprint 01 — storefront</p>
        <h1>One storefront, three ways in</h1>
        <p className="lead">
          A single app that produces events from every surface Polaris supports, against one
          project, one catalog, and one visitor identity. The point is not any single path — it is
          that they agree with each other.
        </p>
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/checkout">
            See the three producers
          </Link>
          <Link className="btn" href="/learn">
            Learn more
          </Link>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Three ways in</h2>
          <p className="muted">
            Same catalog, same visitor, different trust boundary. A real app picks one browser path
            and deletes the other.
          </p>
        </div>
        <div className="cards cards-3">
          {PATHS.map((path) => (
            <article className="card" key={path.title}>
              <h3>{path.title}</h3>
              <p className="card-route">{path.route}</p>
              <p className="muted">{path.blurb}</p>
              <dl className="card-meta">
                <dt>SDK</dt>
                <dd>
                  <code>{path.sdk}</code>
                </dd>
                <dt>Key</dt>
                <dd>{path.key}</dd>
                <dt>Source</dt>
                <dd>
                  <code>{path.source}</code>
                </dd>
              </dl>
              <Link className="card-link" href={path.href}>
                {path.href} →
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Try it</h2>
          <p className="muted">
            Every control below reports twice: once as <span className="tag tag-ui">ui</span> for
            the click, and again as <span className="tag tag-web">web</span> for whatever the SDK
            made of it. Open the activity drawer at the bottom and watch the gap between the two.
          </p>
        </div>
        <div className="split">
          <div className="stack">
            <h3>Identity</h3>
            <IdentityPanel />
          </div>
          <div className="stack">
            <h3>Emit an event</h3>
            <EventPanel />
            <h3>Identity and delivery</h3>
            <DemoPanel />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Learn more</h2>
          <p className="muted">
            This page is for pressing buttons. The explanations live on{" "}
            <Link href="/learn">/learn</Link>, one page you can read start to finish.
          </p>
        </div>
        <div className="cards cards-3">
          {TOPICS.map((topic) => (
            <Link className="card card-clickable" key={topic.href} href={topic.href}>
              <h3>{topic.title}</h3>
              <p className="muted">{topic.blurb}</p>
              <span className="card-link">{topic.href} →</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
