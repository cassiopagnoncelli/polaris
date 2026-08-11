"use client";

import { useActionState, useState } from "react";
import { type ActionState, startCheckout } from "./actions";

const INITIAL: ActionState = { message: "" };

export function CheckoutForm() {
  const [state, formAction, pending] = useActionState(startCheckout, INITIAL);

  return (
    <form action={formAction} className="row">
      <label htmlFor="quantity">Mugs</label>
      <input id="quantity" name="quantity" type="number" min={1} defaultValue={2} />
      <button type="submit" disabled={pending}>
        {pending ? "sending…" : "checkout.started (server action)"}
      </button>
      {state.message !== "" && <span className="muted">{state.message}</span>}
    </form>
  );
}

export function CheckoutFetchButton() {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <div className="row">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void fetch("/api/checkout", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              cart_id: `cart_${Date.now().toString(36)}`,
              items: [{ sku: "STK-014", name: "Sticker Pack", quantity: 3, unit_price: 990 }],
            }),
          })
            .then((response) => response.json())
            .then((result: { event_id?: string; delivered?: number; error?: string }) => {
              setMessage(
                result.error ?? `queued ${result.event_id} — delivered ${result.delivered}`,
              );
            })
            .catch((error: Error) => setMessage(error.message))
            .finally(() => setPending(false));
        }}
      >
        {pending ? "sending…" : "checkout.started (route handler)"}
      </button>
      {message !== "" && <span className="muted">{message}</span>}
    </div>
  );
}
