# GA4: rotating a credential to enable Firebase app-stream routing

Operators use this runbook to move one GA4 destination's app-sourced events
from the web data stream onto a Firebase data stream, by adding
`firebase_app_id` to its credential.

Binding references:

- [`sync/destinations/ga4/v1/SPEC.md`](../../sync/destinations/ga4/v1/SPEC.md) — "Known divergences from canonical"
- [Secret rotation runbook](secret-rotation.md) — the generic procedure this specialises

## When to rotate

Both must be true:

1. Your traffic includes events from a native mobile app SDK — the canonical
   envelope carries `context.app_idfv` (iOS) or `context.app_gaid` (Android).
2. You have a **Firebase data stream** attached to the same GA4 property.

If you have only a web stream, do not rotate. Read [What goes wrong](#what-goes-wrong)
first: this is the one mistake here that fails silently.

Without rotating, nothing breaks. App-sourced events keep flowing to the web
stream with a synthesized `client_id`. Rotation is opt-in and additive.

## How the routing decision is made

The deliverer routes to the Firebase stream only when **both** hold:

- the mapper produced an `app_instance_id` — that is, the envelope had app
  context (`context.app_idfv`, falling back to `context.app_gaid`); and
- the credential carries a non-empty `firebase_app_id`.

```text
app context + firebase_app_id  →  ?firebase_app_id=…&api_secret=…   wrapper: app_instance_id
anything else                  →  ?measurement_id=…&api_secret=…    wrapper: client_id
```

Polaris will not half-route: an app-source envelope on a credential without
`firebase_app_id` stays on the web stream, because GA4 Web rejects
`app_instance_id` requests. See `buildRequestBody` in
[`connectors/destinations/ga4/v1/src/deliverer.ts`](../../connectors/destinations/ga4/v1/src/deliverer.ts).

## 1. Find the Firebase app id

Google Cloud Console → *Project Settings → Your apps → App ID*. Shape:

```text
1:<project_number>:<platform>:<hash>      e.g. 1:1234567890:ios:abc123def456
```

Each mobile platform has its own id. iOS and Android are the ones that route to
app streams; the Web app id is not what you want here.

## 2. Rotate the credential

```bash
polaris destinations rotate-secret polaris_dst_XXXX --secret-value '{"measurement_id":"G-XXXXXXXXXX","api_secret":"…","firebase_app_id":"1:1234567890:ios:abc123def456"}' --reason "enabling Firebase app-stream routing"
```

Three things to get right:

- **All three fields, every time.** The value replaces the credential wholesale.
  `measurement_id` and `api_secret` remain **required** even on the app-stream
  path — a credential missing either fails to parse and every delivery becomes
  `failed_permanent` with `error_class='auth'`. You cannot drop `measurement_id`
  just because app events no longer use it.
- **You cannot read the current credential back.** `secret_value` is write-only
  through every Polaris surface — no CLI verb, page or export prints it. Get
  `measurement_id` and `api_secret` from the GA4 console before you start.
- **`api_host` is not in here.** The Measurement Protocol host is per-project
  configuration (`polaris config set --namespace ga4 --key api_host`), not part
  of the credential. A rotation is the wrong tool for changing hosts.

The new credential is live within the 60s destination-instance cache window. No
restart.

## 3. Verify — this step is load-bearing

Because the credential cannot be read back, **delivery behaviour is the only
confirmation that the rotation took**. Do not skip it.

Send one `payment.approved` envelope with app context populated
(`context.app_idfv`), through the project's SDK or a direct ingest call. GA4's
purchase event is the one with documented dedupe and the easiest to spot in the
reporting UI.

```bash
polaris deliveries list --destination polaris_dst_XXXX --limit 5
```

Expect `accepted` with `vendor_response_code: 204`. Then confirm the event
arrived on the **Firebase** stream — GA4 DebugView, or the stream's realtime
view showing 1 purchase. Confirming it in GA4 is the part that distinguishes a
successful rotation from [the silent failure below](#what-goes-wrong).

If deliveries show `failed_permanent` / `auth`, the credential did not parse —
almost always a missing `measurement_id` or `api_secret`. Re-run step 2 with all
three fields.

## 4. Rollback

Symmetric, and immediate:

```bash
polaris destinations rotate-secret polaris_dst_XXXX --secret-value '{"measurement_id":"G-XXXXXXXXXX","api_secret":"…"}' --reason "reverting app-stream routing"
```

App-source events return to the web-stream URL on the next delivery, within the
same 60s window. No state lives in PostgreSQL or ClickHouse for this — the
credential is the entire switch.

## What goes wrong

**Rotating without a Firebase data stream attached.** GA4 accepts the request
and returns `204 No Content` for a stream that is not configured to receive it.
Polaris records `accepted`, every dashboard looks healthy, and the events are
gone. There is no error anywhere in the pipeline, which is why step 3 asks you
to confirm arrival in GA4 rather than in Polaris.

**An empty `firebase_app_id`.** Treated as absent, not as an error — the
deliverer requires a non-empty string. A credential with `"firebase_app_id": ""`
silently stays on the web stream.

**Assuming `app_instance_id` is Firebase's own installation id.** It is not. The
mapper synthesizes it from `context.app_idfv` / `context.app_gaid`, which is a
device-vendor id, stable across retries for the same device but not identical to
Firebase's installation UUID. Documented as good enough for v1; attribution
drift against Firebase-native reporting is possible and is tracked separately.

## See also

- [Secret rotation runbook](secret-rotation.md)
- [Runbook — destination API failure](runbook-destination-api-failure.md)
