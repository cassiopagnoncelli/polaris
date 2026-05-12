# Priority and Overflow

The Web SDK supports an optional `priority` hint on `track()`. It controls local queue retention only; it does **not** change the canonical event meaning, the ingester's behaviour, or vendor routing.

## Priority values

```ts
type EventPriority = "low" | "normal" | "high";
```

Default is `"normal"`. Set explicitly via `TrackOptions.priority`:

```ts
await sdk.track("payment.approved", { amount: 12990 }, { priority: "high" });
await sdk.track("checkout.started", { cart_id: "ord_123" });             // normal
await sdk.track("ui.heartbeat", { ms: 1500 }, { priority: "low" });
```

The Node SDK does **not** expose a `priority` option. Backend producers do not have the page-exit risk that motivates priority in the browser; if the queue is full, the Node SDK rejects the new event.

## Overflow policy (Web)

When the Web SDK's queue is at `maxQueueSize` and a new event arrives, the queue evicts the **oldest event with the lowest priority** to make room:

```text
1. Drop oldest "low" first.
2. If no "low" entries, drop oldest "normal".
3. If no "normal" entries, drop oldest "high".
4. If all queued entries are "high", drop the oldest high-priority event as a last resort.
```

Each eviction fires `onDrop` with reason `queue_overflow`.

The new event is admitted only when an eligible eviction exists. If a `low`-priority event arrives into a queue full of `high`-priority events, the new `low` event is rejected — it cannot displace anything higher. The SDK fires `onDrop` for the rejected event and returns. **`track()` does not throw on overflow.**

This is the doctrinal rule from [SDK Standards / Queue Priority and Overflow](../architecture/10-sdk-standards.md#queue-priority-and-overflow). The Web SDK uses the layered queue (IndexedDB / localStorage / memory) and the rule applies to whichever layer is active.

## When to use `high`

Reserve `high` for events that genuinely deserve to survive eviction under sustained pressure:

- conversion / revenue events
- explicit consent decisions
- security-relevant events (auth failure spikes)

If everything is `high`, nothing is.

## When to use `low`

Use `low` for events that are useful in aggregate but not individually critical:

- UI heartbeats, scroll-depth pings
- feature-engagement counters
- diagnostic page-perf timings

A `low`-priority event under sustained pressure is the first to be evicted, by design.

## Default `normal` is the right choice for most events

Most catalog events should leave priority unset (or pass `"normal"` explicitly). The priority knob exists to bias the queue under stress; it is not a vendor-routing or analytics-priority signal.

## Priority does not affect:

- the canonical envelope (no `priority` field is sent to the ingester)
- the ingester's accept/reject decision
- downstream processor or consumer ordering
- vendor delivery routing

This is intentional: priority is a **local SDK retention hint**, not a platform-level concern.

## Observing drops

Wire `onDrop` to your local logging:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  diagnostics: {
    onDrop: (entry, reason) => {
      console.warn("polaris drop", {
        reason,
        event: entry.payload.event,
        priority: entry.priority,
        event_id: entry.payload.event_id,
      });
    },
  },
});
```

Reasons surfaced via `onDrop`:

| Reason | Source |
| --- | --- |
| `queue_overflow` | The queue evicted or rejected the event under pressure. |
| `permanent_failure` | The ingester returned a permanent rejection reason. |
| `retry_exhausted` | The retry coordinator hit its cap. |
| `validation_failed` | Client-side validation rejected the event. |

Drop diagnostics never include the event payload beyond what your callback chooses to read off `entry.payload`.

## Tuning `maxQueueSize`

`maxQueueSize` defaults to `1000` events. Increase it when:

- you expect long offline stretches (e.g., a mobile WebView going through a tunnel)
- you have a burst of low-priority events you do not want to drop

Decrease it when:

- you are running in a memory-constrained environment (low-end mobile, kiosks)
- you do not care about offline durability

Above ~10,000 events the queue overhead starts to matter. If you find yourself wanting more than that, your application probably needs a server-side outbox, not a bigger client-side queue.

## Web vs Node summary

| Behaviour | Web SDK | Node SDK |
| --- | --- | --- |
| Priority option | yes (`low`/`normal`/`high`) | no |
| Default priority | `normal` | n/a |
| Overflow policy | evict by priority (oldest low → normal → high) | reject new event |
| `track()` throws on overflow | no | no |
| `onDrop(reason)` fires | yes | yes |
