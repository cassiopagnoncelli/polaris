import { CheckoutButton } from "./checkout-button";

export default function CheckoutPage() {
  return (
    <>
      <h1>A catalog event with a real schema</h1>
      <p className="muted">
        Navigating here already fired a second <code>page.viewed</code>. The button below emits{" "}
        <code>checkout.started</code> v1, whose properties the ingester validates against{" "}
        <code>catalog/events/checkout/started.v1.yaml</code>.
      </p>

      <div className="panel">
        <p>
          <strong>Cart</strong> — 1 × Polaris Mug (BRL 24.90), 2 × Sticker Pack (BRL 9.90)
        </p>
        <CheckoutButton />
      </div>

      <h2>Getting rejected on purpose</h2>
      <p className="muted">
        The second button sends the same event with a broken <code>currency</code>. The ingester
        answers <code>422</code> with a per-event <code>schema_validation_failed</code>, the SDK
        marks it permanent and drops it instead of retrying — watch the activity feed on the home
        page. Partial acceptance is the contract: one bad event never blocks the batch.
      </p>
    </>
  );
}
