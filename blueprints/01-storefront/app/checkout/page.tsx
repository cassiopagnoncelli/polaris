import Link from "next/link";
import { IdentityPanel } from "../identity-panel";
import { BrowserCheckout } from "./browser-checkout";
import { RouteHandlerCheckout, ServerActionCheckout } from "./server-checkout";

export default function CheckoutPage() {
  return (
    <>
      <h1>One event, three producers</h1>
      <p className="muted">
        Navigating here already fired a second <code>page.viewed</code>. Everything below emits{" "}
        <code>checkout.started</code> v1, validated against{" "}
        <code>catalog/events/checkout/started.v1.yaml</code>. The three differ only in who sends
        them — and in <code>flow_variant</code>, which is how you tell them apart later.
      </p>

      <h2>From the browser</h2>
      <p className="muted">
        The Web SDK queues it with the tab&apos;s identity attached and delivers it on the next
        flush. <code>flow_variant: &quot;browser&quot;</code>. The second button sends the same
        event with a broken <code>currency</code> — see{" "}
        <Link href="/learn#catalog">why the browser cannot know it is wrong</Link>.
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
        events above — <Link href="/learn#backend">why that matters</Link>.
      </p>
      <div className="panel">
        <ServerActionCheckout />
      </div>
      <div className="panel">
        <RouteHandlerCheckout />
      </div>

      <h2>Who these landed on</h2>
      <p className="muted">
        Compare <code>anonymous_id</code> here with what each server producer echoed back. Matching
        is the whole point — <Link href="/learn#stitch">the identity stitch</Link>, demonstrated.
      </p>
      <IdentityPanel />
    </>
  );
}
