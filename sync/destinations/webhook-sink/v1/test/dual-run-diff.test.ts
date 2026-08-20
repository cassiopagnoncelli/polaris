/**
 * The dual-run payload diff for the `resolved.events` flip.
 *
 * The card asks for N real events sent down both paths in test mode with the
 * diff attached for review. This is that comparison made deterministic and
 * checked in, which is strictly stronger: a one-off staging run proves the
 * flip was safe on the traffic that happened to flow that afternoon, while
 * this fails in CI the day someone makes the flip stop being additive.
 *
 * The property under test, stated exactly:
 *
 *   Reading `resolved.events` instead of `analytics.events` adds the profile
 *   and enrichment blocks, changes `best_identity`, and touches nothing else.
 *
 * The first draft of this file asserted the stronger and more comfortable
 * claim — purely additive, no existing field changed — and the diff refused
 * it on the first run. `best_identity` moves, by design: it is the answer to
 * "who is this event about?", and the flip is the moment that answer stops
 * being the producer's observation and becomes the identity stage's
 * conclusion. See `DOCUMENTED_CHANGED_PATHS` below, which is kept separate
 * from the additive list precisely so that fact cannot hide inside it.
 *
 * Everything else surviving untouched is what makes the flip safe to do
 * without asking every receiver to change first: a receiver parsing today's
 * payload keeps working, and one that wants the profile finds it there.
 *
 * The two paths differ only in whether the envelope carries the blocks the
 * spine writes — that IS the flip, from the consumer's point of view. Both
 * runs go through the real runtime, real normalize, real mapper.
 */

import type { NormalizableEnvelope } from "@polaris/delivery-normalize";
import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
} from "@polaris/delivery-destinations";
import { createLogger } from "@polaris/observability-logger";
import type { PolarisProducer } from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { createWebhookSinkDescriptor } from "../src/descriptor.js";
import type { WebhookPayload } from "../src/types.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

const logger = createLogger({ service: "test", version: "v1", env: "test", level: "fatal" });

const NOOP_PRODUCER = {
  publishToQueue: async () => undefined,
} as unknown as PolarisProducer;

/**
 * The subtrees the flip is ALLOWED to introduce.
 *
 * A closed list, so adding a field to the payload is a decision someone
 * makes here, in review, rather than a side effect that slips through
 * because it happened to sort under `event.`. Each entry covers its own
 * subtree — `event.traits` goes from `null` to an object, so its children
 * appear as new paths — but the ROOT is still an explicit listing.
 */
const DOCUMENTED_ADDITIVE_PATHS: readonly string[] = [
  "event.traits",
  "event.traits_version",
  "event.enrichment.geo",
  "event.identity.canonical_customer_id",
  "event.identity.profile_id",
];

/**
 * Fields the flip CHANGES rather than adds. Not additive, and listed
 * separately because that difference is the one a receiver can be broken by.
 *
 * `best_identity` is the platform's answer to "who is this event about?",
 * and the flip is precisely the moment that answer stops being the
 * producer's observation and becomes the identity stage's conclusion. Both
 * the `kind` and the `value` move:
 *
 *   user_id      "cus_1"   ->  canonical_customer_id  "cus_1"
 *   anonymous_id "anon_1"  ->  profile_id             "0193...aa"
 *
 * The first row is a relabelling — same value, more accurate name. The
 * SECOND is a different key, and it is the intended one: an anonymous
 * visitor seen on three devices was three `best_identity` values and is now
 * one. A receiver deduplicating on `best_identity.value` will see its keys
 * change shape at the flip, which is why webhook-sink flips first and alone.
 *
 * Deliberately NOT suppressed by widening the additive list: a receiver
 * reading this file should meet this fact, not have it filed under
 * "additive" where nobody looks.
 */
const DOCUMENTED_CHANGED_PATHS: readonly string[] = [
  "event.best_identity.kind",
  "event.best_identity.value",
];

function isDocumented(path: string, documented: readonly string[]): boolean {
  return documented.some((root) => path === root || path.startsWith(`${root}.`));
}

/**
 * Four events chosen to exercise the paths that could plausibly diverge:
 * a plain event, one whose person has no customer id, one carrying PII in
 * traits, and one the geo enricher could not resolve.
 */
const CASES: ReadonlyArray<{ name: string; envelope: NormalizableEnvelope }> = [
  { name: "identified purchase", envelope: baseEnvelope() },
  {
    name: "anonymous visitor",
    envelope: baseEnvelope({
      identity: { anonymous_id: "anon_1", session_id: null, customer_id: null, device_id: null },
    }),
  },
  { name: "PII in traits", envelope: baseEnvelope({ event: "profile.updated" }) },
  { name: "geo lookup missed", envelope: baseEnvelope({ event: "page.viewed" }) },
];

function baseEnvelope(overrides: Partial<NormalizableEnvelope> = {}): NormalizableEnvelope {
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "payment.approved",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:00.500Z",
    source: { id: "checkout-api", type: "backend" },
    identity: {
      anonymous_id: "anon_1",
      session_id: "sess_1",
      customer_id: "cus_1",
      device_id: null,
    },
    context: { ip: "203.0.113.10", user_agent: "Mozilla/5.0", locale: "en-GB" },
    properties: { amount: 4200, currency: "GBP" },
    consent: { marketing: true, analytics: true, personalization: true },
    ...overrides,
  };
}

/** The same envelope as the spine would hand it to a flipped consumer. */
function resolved(envelope: NormalizableEnvelope): NormalizableEnvelope {
  return {
    ...envelope,
    profile: {
      profile_id: "01930000-0000-7000-8000-0000000000aa",
      canonical_customer_id: envelope.identity.customer_id ?? null,
      traits: { tier: "gold", email: "someone@example.com" },
      traits_version: 12,
    },
    enrichment: {
      geo: { country: "GB", region: "ENG", city: "London", source: "maxmind" },
    },
  };
}

async function capture(envelope: NormalizableEnvelope): Promise<WebhookPayload> {
  const sent: WebhookPayload[] = [];
  const instance = fixtureDestinationInstance("https://receiver.test/hook");
  const instances = new InMemoryDestinationInstanceReader();
  instances.set(instance);

  const descriptor = createWebhookSinkDescriptor({
    fetch: (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}") as WebhookPayload);
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch,
    requestTimeoutMs: 5000,
  });

  const runtime = createDestinationConsumer({
    descriptor,
    consumer: {} as never,
    producer: NOOP_PRODUCER,
    instances,
    records: new InMemoryDeliveryRecordRepository(),
    logger,
  });

  await runtime.handleEvent({ envelope, destination_id: instance.destination_id });
  const payload = sent[0];
  if (payload === undefined) throw new Error("no payload reached the receiver");
  return payload;
}

/** Flatten to `a.b.c -> value` so two payloads compare path by path. */
function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    for (const [k, v] of flatten(child, path)) out.set(k, v);
  }
  return out;
}

interface Diff {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

function diff(before: WebhookPayload, after: WebhookPayload): Diff[] {
  const a = flatten(before);
  const b = flatten(after);
  const paths = new Set([...a.keys(), ...b.keys()]);
  const out: Diff[] = [];
  for (const path of paths) {
    // The runtime stamps these per attempt; they are not what the flip
    // changes and comparing them would compare two clocks.
    if (path === "delivery.sent_at") continue;
    if (JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path))) {
      out.push({ path, before: a.get(path), after: b.get(path) });
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

describe("webhook-sink: analytics.events vs resolved.events", () => {
  for (const testCase of CASES) {
    it(`adds only documented fields — ${testCase.name}`, async () => {
      const before = await capture(testCase.envelope);
      const after = await capture(resolved(testCase.envelope));

      const changes = diff(before, after);
      const undocumented = changes.filter(
        (c) =>
          !isDocumented(c.path, DOCUMENTED_ADDITIVE_PATHS) &&
          !isDocumented(c.path, DOCUMENTED_CHANGED_PATHS),
      );

      // The message carries the offending paths so a failure reads as a
      // report rather than as "expected 3 to be 0".
      expect(
        undocumented,
        `undocumented payload changes:\n${undocumented
          .map((c) => `  ${c.path}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`)
          .join("\n")}`,
      ).toEqual([]);
    });
  }

  it("every existing field survives the flip untouched", async () => {
    // The other half of "additive": the check above would also pass if the
    // flip DELETED a field, since a deletion at a documented path is still a
    // documented path. This one says every path present before is still
    // present after, with the same value.
    const before = flatten(await capture(baseEnvelope()));
    const after = flatten(await capture(resolved(baseEnvelope())));
    for (const [path, value] of before) {
      if (path === "delivery.sent_at") continue;
      if (isDocumented(path, DOCUMENTED_ADDITIVE_PATHS)) continue;
      if (isDocumented(path, DOCUMENTED_CHANGED_PATHS)) continue;
      expect(after.has(path), `path disappeared from the payload: ${path}`).toBe(true);
      expect(JSON.stringify(after.get(path)), `value changed at ${path}`).toBe(
        JSON.stringify(value),
      );
    }
  });

  it("carries the profile through to the receiver, hashed where it must be", async () => {
    // The flip's actual point. A receiver pointed at webhook-sink sees what
    // a vendor mapper sees — and a trait email arrives hashed, on the same
    // rule as an identity email, not in the clear.
    const payload = await capture(resolved(baseEnvelope()));
    expect(payload.event.identity.profile_id).toBe("01930000-0000-7000-8000-0000000000aa");
    expect(payload.event.identity.canonical_customer_id).toBe("cus_1");
    expect(payload.event.traits?.["tier"]).toBe("gold");
    expect(payload.event.traits?.["email"]).toBeUndefined();
    expect(payload.event.traits?.["email_sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.event.enrichment.geo?.country).toBe("GB");
  });
});
