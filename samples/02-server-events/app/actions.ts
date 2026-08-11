"use server";

import { getPolaris, identityFromCookies } from "../lib/polaris";

export interface ActionState {
  readonly message: string;
}

/**
 * The same event from a Server Action instead of a route handler. Nothing
 * about the SDK changes: get the singleton, track, flush before returning.
 */
export async function startCheckout(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const quantity = Number(formData.get("quantity") ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { message: "quantity must be a positive integer" };
  }

  const polaris = getPolaris();
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
      { identity: await identityFromCookies() },
    );
    const result = await polaris.flush();
    return { message: `queued ${eventId} — delivered ${result.delivered} to the ingester` };
  } catch (error) {
    // track() throws only on client-side validation (bad event name, bad
    // properties type). Transport failures never reach the caller: they are
    // retried, then surfaced through the diagnostic callbacks.
    return { message: `rejected before queueing: ${(error as Error).message}` };
  }
}
