"use client";

import { useActionState, useEffect, useState } from "react";
import { record } from "../../lib/feed";
import { usePolaris } from "../polaris-provider";
import { type ActionState, startCheckout } from "./actions";

/** Lives here, not in `actions.ts` — see the note there about `"use server"`. */
const INITIAL_ACTION_STATE: ActionState = { message: "", stitchedAnonymousId: null };

/**
 * The same `checkout.started`, produced by the server instead of the tab.
 *
 * Both components below report the `anonymous_id` the server read out of the
 * `polaris_id` cookie. Compare it with the one in the identity panel: they
 * match, which is the whole point — a browser event and a backend event
 * about the same visitor arrive already joined, with no identity resolution
 * needed downstream.
 */

/** Renders the stitch verdict, given what the server echoed back. */
function StitchVerdict({ serverSaw }: { serverSaw: string | null }) {
  const { sdk } = usePolaris();
  const browserHas = sdk?.getEnvelopeIdentity().anonymous_id ?? null;

  if (serverSaw === null) {
    return (
      <span className="muted">
        the server read no <code>polaris_id</code> cookie — this event stands alone
      </span>
    );
  }
  return serverSaw === browserHas ? (
    <span className="muted">
      stitched: the server saw the same <code>anonymous_id</code> this tab is using
    </span>
  ) : (
    <span className="muted">
      the server saw <code>{serverSaw}</code>, this tab has <code>{browserHas ?? "none"}</code> — a{" "}
      <code>reset()</code> between the two will do that
    </span>
  );
}

export function ServerActionCheckout() {
  const [state, formAction, pending] = useActionState(startCheckout, INITIAL_ACTION_STATE);

  // Report into the shared feed so all three producers show up in one list.
  useEffect(() => {
    if (state.message !== "") record("server", `server action: ${state.message}`);
  }, [state]);

  return (
    <form action={formAction} className="row">
      <label htmlFor="quantity">Mugs</label>
      <input id="quantity" name="quantity" type="number" min={1} defaultValue={2} />
      <button type="submit" disabled={pending}>
        {pending ? "sending…" : "checkout.started (server action)"}
      </button>
      {state.message !== "" && (
        <>
          <span className="muted">{state.message}</span>
          <StitchVerdict serverSaw={state.stitchedAnonymousId} />
        </>
      )}
    </form>
  );
}

interface RouteResult {
  event_id?: string;
  delivered?: number;
  stitched_anonymous_id?: string | null;
  error?: string;
}

export function RouteHandlerCheckout() {
  const [result, setResult] = useState<RouteResult | null>(null);
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
            .then((response) => response.json() as Promise<RouteResult>)
            .then((body) => {
              setResult(body);
              record(
                "server",
                body.error ??
                  `route handler: queued ${body.event_id} — delivered ${body.delivered}`,
              );
            })
            .catch((error: Error) => {
              setResult({ error: error.message });
              record("server", `route handler failed: ${error.message}`);
            })
            .finally(() => setPending(false));
        }}
      >
        {pending ? "sending…" : "checkout.started (route handler)"}
      </button>
      {result !== null && (
        <>
          <span className="muted">
            {result.error ?? `queued ${result.event_id} — delivered ${result.delivered}`}
          </span>
          {result.error === undefined && (
            <StitchVerdict serverSaw={result.stitched_anonymous_id ?? null} />
          )}
        </>
      )}
    </div>
  );
}
