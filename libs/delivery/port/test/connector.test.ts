/**
 * Tests for the `destination.port` contract.
 *
 * The bridge tests below matter more than they look: every connector reaches
 * the runtime through `toDestinationDescriptor`, so a field dropped here is a
 * field silently dropped for all five vendors at once — and the two optional
 * ones are dropped by OMITTING the key rather than by setting it to
 * `undefined`, which is a distinction `exactOptionalPropertyTypes` enforces at
 * compile time and nothing enforces at runtime.
 */

import type {
  Deliverer,
  DelivererContext,
  DelivererResult,
  MapperMap,
  MapperResult,
} from "@polaris/delivery-destinations";
import { describe, expect, it } from "vitest";

import {
  type DestinationConnector,
  defineDestinationConnector,
  positiveIntSchema,
  toDestinationDescriptor,
} from "../src/index.js";

interface FakePayload {
  readonly ok: true;
}

interface FakeOptions {
  readonly requestTimeoutMs: number;
}

const MAPPERS: MapperMap<FakePayload> = Object.freeze({
  "checkout.started": (): MapperResult<FakePayload> => ({
    kind: "mapped",
    payload: { ok: true },
  }),
});

/** The runtime never sees this one; only `descriptor.deliverer` is called with it. */
function fakeDelivererContext(): DelivererContext<FakePayload> {
  return {
    payload: { ok: true },
    instance: undefined as unknown as DelivererContext<FakePayload>["instance"],
    secret: "",
    attempt: 1,
    delivery_key: "dk_test",
    projectConfig: {},
  };
}

function fakeConnector(
  overrides: Partial<DestinationConnector<FakePayload, FakeOptions>> = {},
): DestinationConnector<FakePayload, FakeOptions> {
  return {
    slug: "fake-vendor",
    supportedModes: ["event"],
    identity: {
      vendor: "fake",
      component: "fake-vendor",
      consumerVersion: "v1",
      normalizeVersion: "v2",
      mapperVersion: "v1",
      delivererVersion: "v1",
    },
    projectConfigNamespace: "fake-vendor",
    map: MAPPERS,
    deliver: (options: FakeOptions): Deliverer<FakePayload> => {
      return async (): Promise<DelivererResult> => ({
        kind: "accepted",
        vendor_response_summary: `timeout=${String(options.requestTimeoutMs)}`,
      });
    },
    requiredConsent: Object.freeze({ analytics: true }),
    ...overrides,
  };
}

describe("defineDestinationConnector", () => {
  it("returns a frozen connector with a frozen mode list", () => {
    const connector = defineDestinationConnector(fakeConnector());

    expect(Object.isFrozen(connector)).toBe(true);
    expect(Object.isFrozen(connector.supportedModes)).toBe(true);
    expect(connector.slug).toBe("fake-vendor");
  });

  it("accepts a single-segment slug", () => {
    expect(defineDestinationConnector(fakeConnector({ slug: "ga4" })).slug).toBe("ga4");
  });

  it.each([
    "Meta_CAPI",
    "meta capi",
    "-leading",
    "trailing-",
    "double--hyphen",
    "",
  ])("rejects the slug %j", (slug) => {
    expect(() => defineDestinationConnector(fakeConnector({ slug }))).toThrow(/kebab-case/);
  });

  it("rejects an empty mode list", () => {
    expect(() => defineDestinationConnector(fakeConnector({ supportedModes: [] }))).toThrow(
      /no supported modes/,
    );
  });

  it("rejects a repeated mode", () => {
    expect(() =>
      defineDestinationConnector(fakeConnector({ supportedModes: ["event", "event"] })),
    ).toThrow(/more than once/);
  });

  it("does not alias the caller's mode array", () => {
    const modes: DeliveryModeList = ["event"];
    const connector = defineDestinationConnector(fakeConnector({ supportedModes: modes }));

    modes.push("list");

    expect(connector.supportedModes).toEqual(["event"]);
  });
});

type DeliveryModeList = ("event" | "list")[];

describe("toDestinationDescriptor", () => {
  it("carries identity, mappers and consent across", () => {
    const connector = defineDestinationConnector(fakeConnector());

    const descriptor = toDestinationDescriptor(connector, { requestTimeoutMs: 250 });

    expect(descriptor.identity).toBe(connector.identity);
    expect(descriptor.mappers).toBe(MAPPERS);
    expect(descriptor.requiredConsent).toEqual({ analytics: true });
  });

  it("builds the deliverer once, with the options it was given", async () => {
    let built = 0;
    const connector = defineDestinationConnector(
      fakeConnector({
        deliver: (options: FakeOptions): Deliverer<FakePayload> => {
          built += 1;
          return async () => ({
            kind: "accepted",
            vendor_response_summary: `timeout=${String(options.requestTimeoutMs)}`,
          });
        },
      }),
    );

    const descriptor = toDestinationDescriptor(connector, { requestTimeoutMs: 1234 });
    const result = await descriptor.deliverer(fakeDelivererContext());

    expect(built).toBe(1);
    expect(result).toEqual({ kind: "accepted", vendor_response_summary: "timeout=1234" });
  });

  it("omits identityHashing and identityFromProperties when the connector declares neither", () => {
    const descriptor = toDestinationDescriptor(defineDestinationConnector(fakeConnector()), {
      requestTimeoutMs: 1,
    });

    expect("identityHashing" in descriptor).toBe(false);
    expect("identityFromProperties" in descriptor).toBe(false);
  });

  it("forwards identityHashing and identityFromProperties when they are declared", () => {
    const identityFromProperties = (): { email?: string } => ({ email: "a@example.com" });
    const descriptor = toDestinationDescriptor(
      defineDestinationConnector(
        fakeConnector({
          identityHashing: { email: false, phone: false },
          identityFromProperties,
        }),
      ),
      { requestTimeoutMs: 1 },
    );

    expect(descriptor.identityHashing).toEqual({ email: false, phone: false });
    expect(descriptor.identityFromProperties).toBe(identityFromProperties);
  });

  it("does not carry the registry fields the runtime has no use for", () => {
    const descriptor = toDestinationDescriptor(defineDestinationConnector(fakeConnector()), {
      requestTimeoutMs: 1,
    });

    expect("slug" in descriptor).toBe(false);
    expect("supportedModes" in descriptor).toBe(false);
    expect("projectConfigNamespace" in descriptor).toBe(false);
  });
});

describe("positiveIntSchema", () => {
  it("coerces the string form an operator stores", () => {
    expect(positiveIntSchema.parse("5000")).toBe(5000);
  });

  it.each([0, -1, 1.5, "abc"])("rejects %j", (value) => {
    expect(positiveIntSchema.safeParse(value).success).toBe(false);
  });
});
