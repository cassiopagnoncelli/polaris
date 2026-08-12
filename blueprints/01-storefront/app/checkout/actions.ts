"use server";

import { getPolaris, identityFromCookies } from "../../lib/polaris-node";

export interface ActionState {
  readonly message: string;
  /**
   * The `anonymous_id` the server read out of the browser's cookie, echoed
   * back so the page can put it next to the one the Web SDK is using. When
   * the two match, the stitch worked; when this is null, the server saw no
   * usable `polaris_id` cookie and the backend event stands alone.
   */
  readonly stitchedAnonymousId: string | null;
}

// The initial state lives in the client component, not here. A `"use server"`
// module may only export async functions — every other export is turned into
// a server reference, and a plain object cannot be one. Exporting the
// interface above is fine: types are erased before Next sees the module.

/**
 * `checkout.started` from a Server Action.
 *
 * Nothing about the SDK changes between this and the route handler next
 * door: get the singleton, track, flush before returning. The Server Action
 * is just a different way to be called.
 */
export async function startCheckout(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const quantity = Number(formData.get("quantity") ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { message: "quantity must be a positive integer", stitchedAnonymousId: null };
  }

  const identity = await identityFromCookies();

  let polaris: ReturnType<typeof getPolaris>;
  try {
    polaris = getPolaris();
  } catch (error) {
    // A missing backend key is an unfinished setup step. Report it where the
    // page already reports things rather than throwing into the action.
    return { message: (error as Error).message, stitchedAnonymousId: null };
  }

  try {
    const eventId = await polaris.track(
      "checkout.started",
      {
        cart_id: `cart_${Date.now().toString(36)}`,
        total: 2490 * quantity,
        currency: "BRL",
        items: [{ sku: "MUG-001", name: "Polaris Mug", quantity, unit_price: 2490 }],
        flow_variant: "server-action",
      },
      { identity },
    );
    const result = await polaris.flush();
    return {
      message: `queued ${eventId} — delivered ${result.delivered} to the ingester`,
      stitchedAnonymousId: identity.anonymous_id,
    };
  } catch (error) {
    // track() throws only on client-side validation (bad event name, bad
    // properties type). Transport failures never reach the caller: they are
    // retried, then surfaced through the diagnostic callbacks.
    return {
      message: `rejected before queueing: ${(error as Error).message}`,
      stitchedAnonymousId: identity.anonymous_id,
    };
  }
}
